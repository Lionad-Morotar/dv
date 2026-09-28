/**
 * 绑定域 root helper：以 root 身份完成的全部特权操作收拢于此，刻意保持零依赖
 * 与哑语义（不解析 HTTP/DNS，只做文件写入与字节管道），把攻击面压到最小。
 *
 * 职责：写 /etc/resolver/<domain>（含 port 指令与 # dv:bind 标记）→ 刷新 DNS 缓存
 * → 在 :80 起 TCP 哑管道转发给 dv 进程内的代理 → 监视父进程，父亡则自清文件后退出。
 *
 * 清理依赖 watchdog 而非信号钩子：dv 崩溃或被 SIGKILL 时本进程照样感知（ppid 变 1
 * 或父 pid 消失），不会把 resolver 文件遗留在系统里。
 */
import { createServer, connect, type Socket } from 'node:net'
import { createServer as createTlsServer, type TlsOptions } from 'node:tls'
import { execFileSync } from 'node:child_process'
import { writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync, renameSync, fstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 自属标记：pid 使清扫能区分活绑定与孤儿残留（helper 被 SIGKILL 走不到清理路径） */
const MARK_PREFIX = '# dv:bind pid='
const MARK_RE = /# dv:bind pid=(\d+)/

interface HelperOptions {
  proxyPort: number
  dnsPort: number
  parentPid: number
  resolverDir: string
  hostsFile: string
  httpPort: number
  flush: boolean
  /** hosts 降级：不写 resolver，改写 hosts 行（无泛解析能力，子域名不可用） */
  hostsFallback: boolean
  domains: string[]
  /** TLS 终结端口；null = 未启用（与 --http-port 缺省语义区分：显式传参才启用） */
  tlsPort: number | null
  /** leaf 证书/私钥 staging 文件：读入内存后立即删除，staging 目录一并清理 */
  certFile: string | null
  keyFile: string | null
  /** dv 持久 CA 证书：装入系统信任链用（mkcert 模式，用户已在会话中批准） */
  caFile: string | null
  /** 信任安装开关；测试禁用，真机默认执行 */
  trustInstall: boolean
}

function fail(message: string): never {
  process.stderr.write(`dv-bind-helper: ${message}\n`)
  process.exit(1)
}

function parseArgs(argv: string[]): HelperOptions {
  const options: HelperOptions = {
    proxyPort: 0,
    dnsPort: 0,
    parentPid: 0,
    resolverDir: '/etc/resolver',
    hostsFile: '/etc/hosts',
    httpPort: 80,
    flush: true,
    hostsFallback: false,
    domains: [],
    tlsPort: null,
    certFile: null,
    keyFile: null,
    caFile: null,
    trustInstall: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const takeValue = (flag: string): string => {
      const value = argv[++i]
      if (value === undefined) fail(`${flag} 缺少参数值`)
      return value
    }
    if (arg === '--proxy-port') options.proxyPort = Number(takeValue(arg))
    else if (arg === '--dns-port') options.dnsPort = Number(takeValue(arg))
    else if (arg === '--parent-pid') options.parentPid = Number(takeValue(arg))
    else if (arg === '--resolver-dir') options.resolverDir = takeValue(arg)
    else if (arg === '--hosts-file') options.hostsFile = takeValue(arg)
    else if (arg === '--http-port') options.httpPort = Number(takeValue(arg))
    else if (arg === '--tls-port') options.tlsPort = Number(takeValue(arg))
    else if (arg === '--cert-file') options.certFile = takeValue(arg)
    else if (arg === '--key-file') options.keyFile = takeValue(arg)
    else if (arg === '--ca-file') options.caFile = takeValue(arg)
    else if (arg === '--no-flush') options.flush = false
    else if (arg === '--no-trust-install') options.trustInstall = false
    else if (arg === '--hosts-fallback') options.hostsFallback = true
    else if (arg.startsWith('--')) fail(`未知参数 ${arg}`)
    else options.domains.push(arg)
  }
  if (!Number.isInteger(options.proxyPort) || options.proxyPort <= 0) fail('--proxy-port 非法')
  // hosts 降级模式没有 resolver 文件，dnsPort 无消费者，豁免校验
  if (!options.hostsFallback && (!Number.isInteger(options.dnsPort) || options.dnsPort <= 0)) fail('--dns-port 非法')
  if (!Number.isInteger(options.parentPid) || options.parentPid <= 0) fail('--parent-pid 非法')
  if (options.domains.length === 0) fail('缺少绑定域名')
  for (const domain of options.domains) {
    // 域名会成为 /etc/resolver 下的文件名，必须先验形（root 写文件，路径安全是红线）；
    // 长度上限取 DNS 规范的 253，保证 writeFileSync 不会在路上 ENAMETOOLONG
    if (domain.length > 253 || !/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) fail(`域名非法：${domain}`)
  }
  if (options.tlsPort !== null && (!Number.isInteger(options.tlsPort) || options.tlsPort < 0)) fail('--tls-port 非法')
  const tlsEnabled = options.tlsPort !== null
  if (tlsEnabled && (!options.certFile || !options.keyFile)) fail('--tls-port 需要 --cert-file 与 --key-file')
  // 证书参数无 TLS 消费者即误用，严格拒绝避免静默无效
  if (!tlsEnabled && (options.certFile || options.keyFile || options.caFile)) fail('证书参数须与 --tls-port 搭配')
  if (tlsEnabled && options.trustInstall && !options.caFile) fail('--tls-port 的信任安装需要 --ca-file')
  return options
}

function flushDnsCache(): void {
  // 两个命令都可能因系统状态失败，失败不阻断绑定——resolver 文件本身已生效
  for (const [cmd, args] of [
    ['dscacheutil', ['-flushcache']],
    ['killall', ['-HUP', 'mDNSResponder']],
  ] as const) {
    try {
      execFileSync(cmd, [...args], { stdio: 'ignore' })
    } catch {
      process.stderr.write(`dv-bind-helper: ${cmd} 失败，DNS 缓存可能延迟生效\n`)
    }
  }
}

function writeResolverFiles(options: HelperOptions): string[] {
  mkdirSync(options.resolverDir, { recursive: true })
  const written: string[] = []
  const content = `nameserver 127.0.0.1\nport ${options.dnsPort}\n${MARK_PREFIX}${process.pid}\n`
  for (const domain of options.domains) {
    const file = join(options.resolverDir, domain)
    writeFileSync(file, content)
    written.push(file)
  }
  return written
}

function writeHostsEntries(options: HelperOptions): void {
  // 追加写而非整文件重写：/etc/hosts 是系统级配置，truncate 语义下写入中途崩溃即数据丢失
  let existing = ''
  try {
    existing = readFileSync(options.hostsFile, 'utf8')
  } catch {
    // hosts 文件缺失时按空处理，写入即创建
  }
  const lines = options.domains.map((d) => `127.0.0.1 ${d} ${MARK_PREFIX}${process.pid}`)
  const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
  appendFileSync(options.hostsFile, prefix + lines.join('\n') + '\n')
}

/** 整文件重写只经 临时文件 + rename：同目录 rename 在 POSIX 下原子，崩溃最坏留下 .tmp 而非半截 hosts */
function rewriteHostsFile(hostsFile: string, kept: string[]): void {
  const tmp = `${hostsFile}.dv-${process.pid}.tmp`
  writeFileSync(tmp, kept.join('\n'))
  renameSync(tmp, hostsFile)
}

function removeHostsEntries(options: HelperOptions): void {
  try {
    const kept = readFileSync(options.hostsFile, 'utf8')
      .split('\n')
      // 提取数字后严格相等比较：子串匹配会让短 pid 命中长 pid 前缀，误删别的活实例的行
      .filter((line) => Number(line.match(MARK_RE)?.[1]) !== process.pid)
    rewriteHostsFile(options.hostsFile, kept)
  } catch {
    // hosts 文件被外部移除等，清理尽力而为
  }
}

function removeResolverFiles(files: string[]): void {
  // 只删自己写过的文件；同域重绑时新 helper 已重写内容，旧 helper 清理即删文件可接受
  for (const file of files) {
    try {
      rmSync(file)
    } catch {
      // 文件可能已被并发的后继 helper 处理，清理尽力而为
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但无权限发信号，仍是活进程
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 孤儿清扫：标记里 pid 已死的绑定残留（helper 被 SIGKILL 时 watchdog 没机会跑）。
 * 只动带自属标记且 pid 已死的项，外来文件与活绑定一律不碰。
 */
function sweepStale(options: HelperOptions): void {
  try {
    for (const file of readdirSync(options.resolverDir)) {
      const path = join(options.resolverDir, file)
      try {
        const match = readFileSync(path, 'utf8').match(MARK_RE)
        if (match && !isAlive(Number(match[1]))) rmSync(path)
      } catch {
        // 单个文件读删失败不阻断整体清扫
      }
    }
  } catch {
    // resolver 目录不存在即无孤儿
  }
  try {
    const lines = readFileSync(options.hostsFile, 'utf8').split('\n')
    const kept = lines.filter((line) => {
      const match = line.match(MARK_RE)
      return !match || isAlive(Number(match[1]))
    })
    if (kept.length !== lines.length) rewriteHostsFile(options.hostsFile, kept)
  } catch {
    // hosts 缺失同样无孤儿
  }
}

/** 双向字节管道：连接两端即弃式转发，任一侧出错整体 drop（:80 与 TLS 终结共用） */
function pipeBytes(client: Socket, upstreamPort: number, sockets: Socket[]): void {
  // connect 立即返回 socket，连接建立前 pipe 的写入会被缓冲——哑管道无需等上游就绪
  const upstream = connect(upstreamPort, '127.0.0.1')
  client.pipe(upstream)
  upstream.pipe(client)
  sockets.push(client, upstream)
  const drop = () => {
    for (const socket of [client, upstream]) socket.destroy()
  }
  client.on('error', drop)
  upstream.on('error', drop)
  client.on('close', () => sockets.splice(sockets.indexOf(client), 1))
  upstream.on('close', () => sockets.splice(sockets.indexOf(upstream), 1))
}

/** :80 → dv 内嵌代理的哑 TCP 管道；只搬运字节，不理解 HTTP */
async function startDumbPipe(options: HelperOptions, sockets: Socket[]): Promise<number> {
  const server = createServer({ allowHalfOpen: true }, (client: Socket) => {
    // allowHalfOpen：客户端 FIN（写完请求体等响应）后其可读侧仍须保留，
    // 否则默认语义会连写回响应的通道一并掐断
    pipeBytes(client, options.proxyPort, sockets)
  })
  const port = await new Promise<number>((resolvePromise, rejectPromise) => {
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        rejectPromise(new Error(`:${options.httpPort} 被占用——绑定的域必须走 80 端口才能免端口访问`))
        return
      }
      rejectPromise(new Error(`监听失败：${error.message}`))
    })
    server.listen(options.httpPort, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        rejectPromise(new Error('无法获取监听端口'))
        return
      }
      resolvePromise(address.port)
    })
  })
  return port
}

/**
 * :443 TLS 终结管道：终结后仍是哑字节管道（复用 pipeBytes）。ALPN 必须显式钉在
 * http/1.1——浏览器默认协商 h2，终结出的明文会变成 HTTP/2 帧而 http-proxy-3 只懂
 * HTTP/1.1；完全不协商 ALPN 则 Chrome 直接报 no_application_protocol 失败。
 */
async function startTlsPipe(options: HelperOptions, sockets: Socket[], cert: string, key: string): Promise<number> {
  const server = createTlsServer(
    { cert, key, ALPNProtocols: ['http/1.1'], allowHalfOpen: true } satisfies TlsOptions,
    (client: Socket) => {
      pipeBytes(client, options.proxyPort, sockets)
    },
  )
  // 畸形 TLS 握手（端口扫描、curl -k 误用等）触发 tlsClientError，吞掉防崩 helper
  server.on('tlsClientError', () => {})
  const port = await new Promise<number>((resolvePromise, rejectPromise) => {
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        rejectPromise(new Error(`:${options.tlsPort} 被占用——绑定域的 https 必须走 443 端口才能免端口访问`))
        return
      }
      rejectPromise(new Error(`TLS 监听失败：${error.message}`))
    })
    server.listen(options.tlsPort ?? 0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        rejectPromise(new Error('无法获取 TLS 监听端口'))
        return
      }
      resolvePromise(address.port)
    })
  })
  return port
}

/** leaf 材料读入内存后立即删除文件与 staging 目录：root 进程不留证书私钥落盘痕迹 */
async function loadAndDisposeMaterial(options: HelperOptions): Promise<{ cert: string; key: string }> {
  const cert = readFileSync(options.certFile!, 'utf8')
  const key = readFileSync(options.keyFile!, 'utf8')
  unlinkSync(options.certFile!)
  unlinkSync(options.keyFile!)
  rmSync(dirname(options.certFile!), { recursive: true, force: true })
  return { cert, key }
}

/**
 * CA 装入系统信任链（mkcert 模式）：root 写 System keychain，Chrome/Safari 即受信。
 * 失败只降级不阻断——resolver 绑定主路径不受影响，https 退化为证书警告并留提示。
 */
function installTrustedCa(caFile: string): void {
  try {
    execFileSync(
      'security',
      ['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', caFile],
      { stdio: 'ignore' },
    )
  } catch (error) {
    process.stderr.write(
      `dv-bind-helper: CA 信任安装失败（${(error as Error).message.split('\n')[0]}）——https 证书将不受浏览器信任，` +
        '可手动执行: security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain <ca.crt>\n',
    )
  }
}

/**
 * watchdog：主用 kill(parentPid, 0) 心跳 + lstart 钉防 pid 复用（ppid 检查在
 * reparent 到 launchd 后失真）；stdin EOF 守卫仅当 fd0 是 FIFO 时武装
 * （shell 把后台任务 stdin 重定向为 /dev/null 时 EOF 立即到来，武装即误判自杀）。
 */
function armWatchdog(options: HelperOptions, cleanup: () => void): void {
  // 进程启动时间钉：pid 复用后 kill(pid, 0) 照样成功，但 lstart 必然变化——
  // 没这枚钉子，dv 崩溃且 pid 被复用时 helper 与 resolver 文件会永久滞留
  let parentStart: string | undefined
  try {
    parentStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(options.parentPid)], {
      encoding: 'utf8',
    })
  } catch {
    parentStart = undefined
  }
  const heartbeat = setInterval(() => {
    try {
      process.kill(options.parentPid, 0)
      if (parentStart !== undefined) {
        const current = execFileSync('ps', ['-o', 'lstart=', '-p', String(options.parentPid)], {
          encoding: 'utf8',
        })
        if (current !== parentStart) throw new Error('parent pid reused')
      }
    } catch {
      cleanup()
      process.exit(0)
    }
  }, 2000)
  heartbeat.unref()

  // spawn stdio 'pipe' 在 macOS 落地为 socketpair 而非 FIFO，两种形态都要武装；
  // 要排除的是 /dev/null（字符设备，open 即 EOF，shell 后台任务的 stdin 默认值）
  let stdinCanSignal = false
  try {
    const fd0 = fstatSync(0)
    stdinCanSignal = fd0.isFIFO() || fd0.isSocket()
  } catch {
    stdinCanSignal = false
  }
  if (stdinCanSignal) {
    process.stdin.on('end', () => {
      cleanup()
      process.exit(0)
    })
    process.stdin.resume()
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const sockets: Socket[] = []
  // 管道就绪先于系统变更：listen 错误是异步的，写文件必须等 listen 落定，
  // 否则 EADDRINUSE 会把指向死端口的 resolver 文件留在系统里
  const port = await startDumbPipe(options, sockets).catch((error: Error) => fail(error.message))
  // TLS 管道同样先于系统变更启动；材料读后即删，端口回报在 READY 前（启动器只解析 READY 行）
  if (options.tlsPort !== null) {
    // 读删失败（staging 被启动器超时清理等）与其他 listen 失败同走 fail 契约，不裸抛堆栈
    const material = await loadAndDisposeMaterial(options).catch((error: Error) => fail(error.message))
    const tlsPort = await startTlsPipe(options, sockets, material.cert, material.key).catch((error: Error) => fail(error.message))
    process.stdout.write(`TLS ${tlsPort}\n`)
  }
  sweepStale(options)
  let written: string[] = []
  try {
    if (options.hostsFallback) writeHostsEntries(options)
    else written = writeResolverFiles(options)
    if (options.flush) flushDnsCache()
  } catch (error) {
    removeResolverFiles(written)
    fail(`写绑定配置失败：${(error as Error).message}`)
  }
  if (options.tlsPort !== null && options.trustInstall) installTrustedCa(options.caFile!)
  const cleanupFiles = () => {
    removeResolverFiles(written)
    if (options.hostsFallback) removeHostsEntries(options)
  }
  process.stdout.write(`READY ${port}\n`)
  armWatchdog(options, () => {
    cleanupFiles()
    for (const socket of sockets) socket.destroy()
    if (options.flush) flushDnsCache()
  })
}

await main()
