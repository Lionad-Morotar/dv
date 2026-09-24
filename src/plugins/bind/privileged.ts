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
import { execFileSync } from 'node:child_process'
import { writeFileSync, rmSync, fstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

interface HelperOptions {
  proxyPort: number
  dnsPort: number
  parentPid: number
  resolverDir: string
  httpPort: number
  flush: boolean
  domains: string[]
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
    httpPort: 80,
    flush: true,
    domains: [],
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
    else if (arg === '--http-port') options.httpPort = Number(takeValue(arg))
    else if (arg === '--no-flush') options.flush = false
    else if (arg.startsWith('--')) fail(`未知参数 ${arg}`)
    else options.domains.push(arg)
  }
  if (!Number.isInteger(options.proxyPort) || options.proxyPort <= 0) fail('--proxy-port 非法')
  if (!Number.isInteger(options.dnsPort) || options.dnsPort <= 0) fail('--dns-port 非法')
  if (!Number.isInteger(options.parentPid) || options.parentPid <= 0) fail('--parent-pid 非法')
  if (options.domains.length === 0) fail('缺少绑定域名')
  for (const domain of options.domains) {
    // 域名会成为 /etc/resolver 下的文件名，必须先验形（root 写文件，路径安全是红线）；
    // 长度上限取 DNS 规范的 253，保证 writeFileSync 不会在路上 ENAMETOOLONG
    if (domain.length > 253 || !/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) fail(`域名非法：${domain}`)
  }
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
  const content = `nameserver 127.0.0.1\nport ${options.dnsPort}\n# dv:bind\n`
  for (const domain of options.domains) {
    const file = join(options.resolverDir, domain)
    writeFileSync(file, content)
    written.push(file)
  }
  return written
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

/** :80 → dv 内嵌代理的哑 TCP 管道；只搬运字节，不理解 HTTP */
async function startDumbPipe(options: HelperOptions): Promise<{ sockets: Socket[]; port: number }> {
  const sockets: Socket[] = []
  const server = createServer({ allowHalfOpen: true }, (client: Socket) => {
    // allowHalfOpen：客户端 FIN（写完请求体等响应）后其可读侧仍须保留，
    // 否则默认语义会连写回响应的通道一并掐断
    // connect 立即返回 socket，连接建立前 pipe 的写入会被缓冲——哑管道无需等上游就绪
    const upstream = connect(options.proxyPort, '127.0.0.1')
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
  })
  const port = await new Promise<number>((resolvePromise, rejectPromise) => {
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        rejectPromise(new Error(`:${options.httpPort} 被占用——绑定的域必须走 80 端口才能免端口访问`))
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
  return { sockets, port }
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
  // 管道就绪先于系统变更：listen 错误是异步的，写文件必须等 listen 落定，
  // 否则 EADDRINUSE 会把指向死端口的 resolver 文件留在系统里
  const { sockets, port } = await startDumbPipe(options).catch((error: Error) => fail(error.message))
  let written: string[] = []
  try {
    written = writeResolverFiles(options)
    if (options.flush) flushDnsCache()
  } catch (error) {
    removeResolverFiles(written)
    fail(`写 resolver 文件失败：${(error as Error).message}`)
  }
  process.stdout.write(`READY ${port}\n`)
  armWatchdog(options, () => {
    removeResolverFiles(written)
    for (const socket of sockets) socket.destroy()
    if (options.flush) flushDnsCache()
  })
}

await main()
