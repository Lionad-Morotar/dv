import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { spawnBindHelper } from '../src/plugins/bind/helper.ts'

const HELPER = fileURLToPath(new URL('../src/plugins/bind/privileged.ts', import.meta.url))

/** 以当前用户直接起 helper（注入路径与高端口，绕开 root 需求） */
function spawnHelper(
  args: string[],
  options: { stdin?: 'pipe' | 'ignore'; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  return spawn(process.execPath, ['--experimental-strip-types', HELPER, ...args], {
    stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    ...(options.env ? { env: options.env } : {}),
  })
}

function waitReady(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = /READY (\d+)/.exec(buffer)
      if (match) {
        child.stdout?.off('data', onData)
        resolvePromise(Number(match[1]))
      }
    }
    child.stdout?.on('data', onData)
    child.on('exit', (code) => rejectPromise(new Error(`helper exited ${code} before READY`)))
    setTimeout(() => rejectPromise(new Error('READY timeout')), 8000)
  })
}

/** 假父进程：长寿占位，供 watchdog 监视 */
function spawnFakeParent(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
}

async function waitExit(child: ChildProcess, timeoutMs = 8000): Promise<number | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('exit timeout')), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolvePromise(code)
    })
  })
}

describe('privileged helper', () => {
  let dir: string
  let children: ChildProcess[]
  let servers: Server[]

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    for (const server of servers) {
      await new Promise<void>((r) => server.close(() => r()))
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('writes resolver files with nameserver, port and marker', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    servers = []
    const child = spawnHelper([
      '--proxy-port', '1', '--dns-port', '5353', '--parent-pid', String(process.pid),
      '--resolver-dir', dir, '--http-port', '0', '--no-flush', 'dv-test.invalid', 'app.dv-test2.invalid',
    ])
    children.push(child)
    await waitReady(child)
    const files = await readdir(dir)
    expect(files.sort()).toEqual(['app.dv-test2.invalid', 'dv-test.invalid'])
    const content = await readFile(join(dir, 'dv-test.invalid'), 'utf8')
    expect(content).toContain('nameserver 127.0.0.1')
    expect(content).toContain('port 5353')
    expect(content).toContain('# dv:bind')
  })

  it('pipes TCP bytes to the proxy port and back, surviving client half-close', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    servers = []
    // 回声上游充当 dv 进程内代理
    const upstream = createServer((socket: Socket) => socket.on('data', (c) => socket.write(c)))
    servers.push(upstream)
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const upstreamPort = (upstream.address() as { port: number }).port

    const child = spawnHelper([
      '--proxy-port', String(upstreamPort), '--dns-port', '5353', '--parent-pid', String(process.pid),
      '--resolver-dir', dir, '--http-port', '0', '--no-flush', 'dv-test.invalid',
    ])
    children.push(child)
    const port = await waitReady(child)
    expect(port).toBeGreaterThan(0)

    // 写完立即 FIN（半关闭），响应仍须回到客户端——allowHalfOpen 的保卫用例
    const client = connect(port, '127.0.0.1')
    const echoed = new Promise<string>((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = []
      client.on('data', (c) => chunks.push(c))
      client.on('end', () => resolvePromise(Buffer.concat(chunks).toString()))
      client.on('error', rejectPromise)
      setTimeout(() => rejectPromise(new Error('echo timeout')), 5000)
    })
    client.write('half-close-payload')
    client.end()
    expect(await echoed).toBe('half-close-payload')
  })

  // watchdog 心跳 2s 一轮，并行全量下 spawn 变慢，须给足余量
  it('exits and removes resolver files when the parent process dies', { timeout: 15000 }, async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    servers = []
    const parent = spawnFakeParent()
    const child = spawnHelper([
      '--proxy-port', '1', '--dns-port', '5353', '--parent-pid', String(parent.pid),
      '--resolver-dir', dir, '--http-port', '0', '--no-flush', 'dv-test.invalid',
    ])
    children.push(child)
    await waitReady(child)
    parent.kill('SIGKILL')
    const code = await waitExit(child)
    expect(code).toBe(0)
    expect(await readdir(dir)).toEqual([])
  })

  it('does not arm the stdin guard when stdin is /dev/null', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    servers = []
    const child = spawnHelper(
      ['--proxy-port', '1', '--dns-port', '5353', '--parent-pid', String(process.pid),
        '--resolver-dir', dir, '--http-port', '0', '--no-flush', 'dv-test.invalid'],
      { stdin: 'ignore' },
    )
    children.push(child)
    await waitReady(child)
    // stdin 是 ignore（/dev/null，open 即 EOF）——helper 不得误判为父进程消亡
    await new Promise((r) => setTimeout(r, 500))
    expect(child.exitCode).toBeNull()
  })

  it('fails with non-zero exit when the http port is occupied', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    servers = []
    const blocker = createServer()
    servers.push(blocker)
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const taken = (blocker.address() as { port: number }).port

    const child = spawnHelper([
      '--proxy-port', '1', '--dns-port', '5353', '--parent-pid', String(process.pid),
      '--resolver-dir', dir, '--http-port', String(taken), '--no-flush', 'dv-test.invalid',
    ])
    children.push(child)
    const code = await waitExit(child)
    expect(code).not.toBe(0)
    // 管道先于系统变更启动：端口冲突失败不得留下半绑定状态
    expect(await readdir(dir)).toEqual([])
  })
})

describe('spawnBindHelper（启动器）', () => {
  let dir: string

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves with the listening port and stops the helper via stdin EOF', { timeout: 15000 }, async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    const helper = await spawnBindHelper({
      proxyPort: 1,
      dnsPort: 5353,
      domains: ['dv-test.invalid'],
      resolverDir: dir,
      httpPort: 0,
      flush: false,
      command: [process.execPath, '--experimental-strip-types'],
    })
    expect(helper.httpPort).toBeGreaterThan(0)
    helper.stop()
    await new Promise<void>((r) => helper.child.on('exit', () => r()))
    expect(await readdir(dir)).toEqual([])
  })

  it('rejects with DvError when the helper exits 0 before READY', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    // 假 helper：静默以 0 退出，模拟 watchdog 首轮即触发之类"就绪前正常消亡"路径
    const quitter = join(dir, 'quitter.mjs')
    await writeFile(quitter, 'process.exit(0)\n')
    await expect(
      spawnBindHelper({
        proxyPort: 1,
        dnsPort: 5353,
        domains: ['dv-test.invalid'],
        resolverDir: dir,
        httpPort: 0,
        flush: false,
        command: [process.execPath, quitter],
      }),
    ).rejects.toThrow(/helper 退出/)
  })

  it('rejects with DvError when the helper exits non-zero before READY', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    const quitter = join(dir, 'quitter.mjs')
    await writeFile(quitter, 'process.exit(1)\n')
    await expect(
      spawnBindHelper({
        proxyPort: 1,
        dnsPort: 5353,
        domains: ['dv-test.invalid'],
        resolverDir: dir,
        httpPort: 0,
        flush: false,
        command: [process.execPath, quitter],
      }),
    ).rejects.toThrow(/helper 退出/)
  })
})

describe('privileged helper：stale 清扫与 hosts 降级', () => {
  let dir: string
  let children: ChildProcess[]

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await rm(dir, { recursive: true, force: true })
  })

  /** 拿一个确定已死的 pid：spawn 后等它退出 */
  async function deadPid(): Promise<number> {
    const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise<void>((r) => p.on('exit', () => r()))
    return p.pid!
  }

  it('marks resolver files with the helper pid', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    const child = spawnHelper([
      '--proxy-port', '1', '--dns-port', '5353', '--parent-pid', String(process.pid),
      '--resolver-dir', dir, '--http-port', '0', '--no-flush', 'dv-test.invalid',
    ])
    children.push(child)
    await waitReady(child)
    const content = await readFile(join(dir, 'dv-test.invalid'), 'utf8')
    expect(content).toMatch(new RegExp(`# dv:bind pid=${child.pid}`))
  })

  it('sweeps stale resolver files of dead helpers but keeps live and foreign ones', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    const stale = await deadPid()
    await writeFile(join(dir, 'stale.invalid'), `nameserver 127.0.0.1\nport 1111\n# dv:bind pid=${stale}\n`)
    await writeFile(join(dir, 'live.invalid'), `nameserver 127.0.0.1\nport 2222\n# dv:bind pid=${process.pid}\n`)
    await writeFile(join(dir, 'foreign.invalid'), 'nameserver 8.8.8.8\n')

    const child = spawnHelper([
      '--proxy-port', '1', '--dns-port', '5353', '--parent-pid', String(process.pid),
      '--resolver-dir', dir, '--http-port', '0', '--no-flush', 'dv-test.invalid',
    ])
    children.push(child)
    await waitReady(child)
    const files = (await readdir(dir)).sort()
    expect(files).toEqual(['dv-test.invalid', 'foreign.invalid', 'live.invalid'])
  })

  it('hosts-fallback mode writes marked hosts lines instead of resolver files and removes them on exit', { timeout: 15000 }, async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    const hostsFile = join(dir, 'etc', 'hosts')
    await mkdir(join(dir, 'etc'))
    await writeFile(hostsFile, '127.0.0.1 localhost\n')
    const parent = spawnFakeParent()
    const child = spawnHelper([
      '--proxy-port', '1', '--dns-port', '5353', '--parent-pid', String(parent.pid),
      '--resolver-dir', dir, '--http-port', '0', '--no-flush',
      '--hosts-fallback', '--hosts-file', hostsFile, 'dv-test.invalid',
    ])
    children.push(child)
    await waitReady(child)
    // hosts 模式不写 resolver 文件
    expect(await readdir(dir)).toEqual(['etc'])
    const hosts = await readFile(hostsFile, 'utf8')
    expect(hosts).toContain('127.0.0.1 localhost')
    expect(hosts).toMatch(new RegExp(`127\\.0\\.0\\.1 dv-test\\.invalid # dv:bind pid=${child.pid}`))

    parent.kill('SIGKILL')
    await waitExit(child)
    expect(await readFile(hostsFile, 'utf8')).toBe('127.0.0.1 localhost\n')
  })

  it('sweeps stale hosts lines of dead helpers', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    const stale = await deadPid()
    const hostsFile = join(dir, 'etc', 'hosts')
    await mkdir(join(dir, 'etc'))
    await writeFile(
      hostsFile,
      `127.0.0.1 localhost\n127.0.0.1 old.invalid # dv:bind pid=${stale}\n127.0.0.1 keep.invalid # dv:bind pid=${process.pid}\n`,
    )
    const child = spawnHelper([
      '--proxy-port', '1', '--dns-port', '5353', '--parent-pid', String(process.pid),
      '--resolver-dir', dir, '--http-port', '0', '--no-flush',
      '--hosts-fallback', '--hosts-file', hostsFile, 'dv-test.invalid',
    ])
    children.push(child)
    await waitReady(child)
    const hosts = await readFile(hostsFile, 'utf8')
    expect(hosts).not.toContain('old.invalid')
    expect(hosts).toContain('127.0.0.1 keep.invalid')
    expect(hosts).toContain('127.0.0.1 localhost')
  })
})

describe('privileged helper：pid 前缀撞车', () => {
  let dir: string
  let children: ChildProcess[]

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('cleanup removes only the exact-own-pid lines, not prefix-colliding ones', { timeout: 15000 }, async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    const hostsFile = join(dir, 'etc', 'hosts')
    await mkdir(join(dir, 'etc'))
    await writeFile(hostsFile, '127.0.0.1 localhost\n')
    const parent = spawnFakeParent()
    const child = spawnHelper([
      '--proxy-port', '1', '--dns-port', '5353', '--parent-pid', String(parent.pid),
      '--resolver-dir', dir, '--http-port', '0', '--no-flush',
      '--hosts-fallback', '--hosts-file', hostsFile, 'dv-test.invalid',
    ])
    children.push(child)
    await waitReady(child)
    // 前缀撞车：pid=123 的自属标记是 pid=1239 行的子串，子串匹配会误删
    const colliding = Number(`${child.pid}9`)
    const { appendFile } = await import('node:fs/promises')
    await appendFile(hostsFile, `127.0.0.1 other.invalid # dv:bind pid=${colliding}\n`)

    parent.kill('SIGKILL')
    await waitExit(child)
    const hosts = await readFile(hostsFile, 'utf8')
    expect(hosts).not.toContain('dv-test.invalid')
    expect(hosts).toContain(`pid=${colliding}`)
    expect(hosts).toContain('127.0.0.1 localhost')
  })
})

describe('privileged helper：TLS 管道与信任安装', () => {
  let dir: string
  let children: ChildProcess[]
  let servers: Server[]

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    for (const server of servers) {
      await new Promise<void>((r) => server.close(() => r()))
    }
    await rm(dir, { recursive: true, force: true })
  })

  /** 用 S1 证书模块真签一套 CA + leaf staging（helper 只认文件，不关心来源） */
  async function makeLeafMaterial(): Promise<{ caPath: string; certPath: string; keyPath: string; caPem: string }> {
    const { loadOrCreateCa, issueLeafCertificate } = await import('../src/plugins/bind/cert.ts')
    const ca = await loadOrCreateCa({ caDir: join(dir, 'ca') })
    const leaf = await issueLeafCertificate(ca, ['dv-test.invalid'], { tmpDir: dir })
    return { caPath: ca.certPath, certPath: leaf.certPath, keyPath: leaf.keyPath, caPem: ca.cert }
  }

  /** TLS 端口在 READY 前以 `TLS <port>` 行单独回报；无 --tls-port 时只有 READY 行 */
  function waitReadyTls(child: ChildProcess): Promise<{ http: number; tls: number | null }> {
    return new Promise((resolvePromise, rejectPromise) => {
      let buffer = ''
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString()
        const tlsMatch = /(?:^|\n)TLS (\d+)/.exec(buffer)
        const readyMatch = /(?:^|\n)READY (\d+)/.exec(buffer)
        if (readyMatch) {
          child.stdout?.off('data', onData)
          resolvePromise({ http: Number(readyMatch[1]), tls: tlsMatch ? Number(tlsMatch[1]) : null })
        }
      }
      child.stdout?.on('data', onData)
      child.on('exit', (code) => rejectPromise(new Error(`helper exited ${code} before READY`)))
      setTimeout(() => rejectPromise(new Error('READY timeout')), 8000)
    })
  }

  /** TLS 回声探测：以 CA 信任连接，断言握手、ALPN 协商与半关闭回声 */
  function tlsProbe(
    port: number,
    caPem: string,
    servername: string,
    payload: string,
  ): Promise<{ authorized: boolean; alpn: string | null; echo: string }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const socket: TLSSocket = tlsConnect(
        { port, host: '127.0.0.1', servername, ca: caPem, ALPNProtocols: ['h2', 'http/1.1'], rejectUnauthorized: true },
        () => {
          socket.write(payload)
          socket.end()
        },
      )
      const chunks: Buffer[] = []
      socket.on('data', (c: Buffer) => chunks.push(c))
      socket.on('close', () => {
        const result: { authorized: boolean; alpn: string | null; echo: string } = {
          authorized: socket.authorized === true,
          alpn: typeof socket.alpnProtocol === 'string' ? socket.alpnProtocol : null,
          echo: Buffer.concat(chunks).toString(),
        }
        resolvePromise(result)
      })
      socket.on('error', rejectPromise)
      setTimeout(() => rejectPromise(new Error('tls probe timeout')), 5000)
    })
  }

  /** 假 security 命令：把收到的参数原样落日志后按给定码退出（PATH 注入） */
  async function makeFakeSecurity(exitCode: number): Promise<{ env: NodeJS.ProcessEnv; logFile: string }> {
    const fakeBin = join(dir, 'fakebin')
    await mkdir(fakeBin, { recursive: true })
    const logFile = join(dir, 'security.log')
    const script = `#!/bin/sh\nprintf 'security %s\\n' "$*" >> "$DV_FAKE_SECURITY_LOG"\nexit ${exitCode}\n`
    await writeFile(join(fakeBin, 'security'), script, { mode: 0o755 })
    return {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, DV_FAKE_SECURITY_LOG: logFile },
      logFile,
    }
  }

  it('serves TLS on the tls port with CA-verifiable handshake and http/1.1 ALPN', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    servers = []
    const upstream = createServer((socket: Socket) => socket.on('data', (c) => socket.write(c)))
    servers.push(upstream)
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const upstreamPort = (upstream.address() as { port: number }).port

    const { caPath, certPath, keyPath, caPem } = await makeLeafMaterial()
    const child = spawnHelper([
      '--proxy-port', String(upstreamPort), '--dns-port', '5353', '--parent-pid', String(process.pid),
      '--resolver-dir', dir, '--http-port', '0', '--no-flush',
      '--tls-port', '0', '--cert-file', certPath, '--key-file', keyPath,
      '--ca-file', caPath, '--no-trust-install', 'dv-test.invalid',
    ])
    children.push(child)
    const { tls } = await waitReadyTls(child)
    expect(tls).not.toBeNull()
    expect(tls!).toBeGreaterThan(0)

    const probe = await tlsProbe(tls!, caPem, 'dv-test.invalid', 'tls-half-close-payload')
    expect(probe.authorized).toBe(true)
    expect(probe.alpn).toBe('http/1.1')
    expect(probe.echo).toBe('tls-half-close-payload')

    // leaf 材料读后即删，staging 目录一并清掉
    expect(existsSync(certPath)).toBe(false)
    expect(existsSync(keyPath)).toBe(false)
    expect(existsSync(dirname(certPath))).toBe(false)
  })

  it('installs the CA into the system trust store via security add-trusted-cert', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    servers = []
    const upstreamPort = await (async () => {
      const upstream = createServer((socket: Socket) => socket.on('data', (c) => socket.write(c)))
      servers.push(upstream)
      await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
      return (upstream.address() as { port: number }).port
    })()

    const { caPath, certPath, keyPath, caPem } = await makeLeafMaterial()
    const { env, logFile } = await makeFakeSecurity(0)
    const child = spawnHelper(
      [
        '--proxy-port', String(upstreamPort), '--dns-port', '5353', '--parent-pid', String(process.pid),
        '--resolver-dir', dir, '--http-port', '0', '--no-flush',
        '--tls-port', '0', '--cert-file', certPath, '--key-file', keyPath,
        '--ca-file', caPath, 'dv-test.invalid',
      ],
      { env },
    )
    children.push(child)
    const { tls } = await waitReadyTls(child)
    expect(tls).not.toBeNull()

    const log = await readFile(logFile, 'utf8')
    expect(log).toContain(`security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${caPath}`)
    // 信任安装照常进行的同时，材料与既有断言口径一致：读后即删
    expect(existsSync(certPath)).toBe(false)
    expect(existsSync(keyPath)).toBe(false)
    // probe 连通性（trust 安装不破坏 TLS 管道）
    const probe = await tlsProbe(tls!, caPem, 'dv-test.invalid', 'trust-ok')
    expect(probe.echo).toBe('trust-ok')
  })

  it('skips the security invocation under --no-trust-install', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    servers = []
    const upstream = createServer((socket: Socket) => socket.on('data', (c) => socket.write(c)))
    servers.push(upstream)
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const upstreamPort = (upstream.address() as { port: number }).port

    const { caPath, certPath, keyPath } = await makeLeafMaterial()
    const { env, logFile } = await makeFakeSecurity(0)
    const child = spawnHelper(
      [
        '--proxy-port', String(upstreamPort), '--dns-port', '5353', '--parent-pid', String(process.pid),
        '--resolver-dir', dir, '--http-port', '0', '--no-flush',
        '--tls-port', '0', '--cert-file', certPath, '--key-file', keyPath,
        '--ca-file', caPath, '--no-trust-install', 'dv-test.invalid',
      ],
      { env },
    )
    children.push(child)
    await waitReadyTls(child)
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(logFile)).toBe(false)
  })

  it('trust install failure does not block READY', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    servers = []
    const upstream = createServer((socket: Socket) => socket.on('data', (c) => socket.write(c)))
    servers.push(upstream)
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const upstreamPort = (upstream.address() as { port: number }).port

    const { caPath, certPath, keyPath, caPem } = await makeLeafMaterial()
    const { env } = await makeFakeSecurity(1)
    const child = spawnHelper(
      [
        '--proxy-port', String(upstreamPort), '--dns-port', '5353', '--parent-pid', String(process.pid),
        '--resolver-dir', dir, '--http-port', '0', '--no-flush',
        '--tls-port', '0', '--cert-file', certPath, '--key-file', keyPath,
        '--ca-file', caPath, 'dv-test.invalid',
      ],
      { env },
    )
    children.push(child)
    const { tls } = await waitReadyTls(child)
    expect(tls).not.toBeNull()
    // 信任安装失败只降级不阻断：TLS 管道照常服务
    const probe = await tlsProbe(tls!, caPem, 'dv-test.invalid', 'degraded-but-up')
    expect(probe.echo).toBe('degraded-but-up')
  })

  it('fails with non-zero exit when the TLS port is occupied', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    servers = []
    const blocker = createServer()
    servers.push(blocker)
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const taken = (blocker.address() as { port: number }).port

    const { certPath, keyPath } = await makeLeafMaterial()
    const resolverDir = join(dir, 'resolver')
    await mkdir(resolverDir)
    const child = spawnHelper([
      '--proxy-port', '1', '--dns-port', '5353', '--parent-pid', String(process.pid),
      '--resolver-dir', resolverDir, '--http-port', '0', '--no-flush',
      '--tls-port', String(taken), '--cert-file', certPath, '--key-file', keyPath,
      '--ca-file', join(dir, 'ca', 'ca.crt'), '--no-trust-install', 'dv-test.invalid',
    ])
    children.push(child)
    const code = await waitExit(child)
    expect(code).not.toBe(0)
    // 管道先于系统变更启动：TLS 端口冲突同样不得留下半绑定状态
    expect(await readdir(resolverDir)).toEqual([])
  })

  it('keeps the READY contract without --tls-port (no TLS line, no trust install)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dv-helper-'))
    children = []
    servers = []
    const upstream = createServer((socket: Socket) => socket.on('data', (c) => socket.write(c)))
    servers.push(upstream)
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const upstreamPort = (upstream.address() as { port: number }).port

    const { env, logFile } = await makeFakeSecurity(0)
    const child = spawnHelper(
      [
        '--proxy-port', String(upstreamPort), '--dns-port', '5353', '--parent-pid', String(process.pid),
        '--resolver-dir', dir, '--http-port', '0', '--no-flush', 'dv-test.invalid',
      ],
      { env },
    )
    children.push(child)
    const { tls } = await waitReadyTls(child)
    expect(tls).toBeNull()
    // 未启用 TLS 时信任安装也不发生
    expect(existsSync(logFile)).toBe(false)
  })
})

