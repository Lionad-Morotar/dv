import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DvError } from '../../core/pkg.ts'

export interface SpawnHelperOptions {
  /** dv 进程内代理端口（:80 哑管道的转发目标） */
  proxyPort: number
  /** dv 进程内 DNS 应答器端口（写进 resolver 文件的 port 指令） */
  dnsPort: number
  domains: string[]
  /** 默认 process.pid；测试注入假父进程 */
  parentPid?: number
  /** 默认 /etc/resolver；测试注入 tmpdir */
  resolverDir?: string
  /** 默认 80；测试注入 ephemeral（0 表示系统分配） */
  httpPort?: number
  /** 默认 true；注入路径下 dscacheutil/killall 无需执行 */
  flush?: boolean
  /** 默认 ['sudo', process.execPath]；测试注入去掉 sudo 的直起命令 */
  command?: string[]
}

export interface BindHelper {
  child: ChildProcess
  /** 实际监听的 http 端口（READY 行回读；生产恒为 80） */
  httpPort: number
  /** 请求 helper 自清理并退出（watchdog 路径之外的正常关停） */
  stop: () => void
}

/** 打包产物是 dist/cli.mjs + dist/plugins/bind/privileged.mjs；源码态（vitest）同目录是 .ts */
function resolveHelperEntry(): string {
  const dist = fileURLToPath(new URL('./plugins/bind/privileged.mjs', import.meta.url))
  if (existsSync(dist)) return dist
  return fileURLToPath(new URL('./privileged.ts', import.meta.url))
}

/**
 * 以 sudo 拉起 root helper 并等待其 READY。sudo 走 /dev/tty 交互输密码，
 * stdin 保持管道给 helper 的 EOF 守卫；非 TTY 环境 sudo 直接失败 → DvError。
 */
export async function spawnBindHelper(options: SpawnHelperOptions): Promise<BindHelper> {
  const command = options.command ?? ['sudo', process.execPath]
  const args = [
    ...command.slice(1),
    resolveHelperEntry(),
    '--proxy-port', String(options.proxyPort),
    '--dns-port', String(options.dnsPort),
    '--parent-pid', String(options.parentPid ?? process.pid),
    '--resolver-dir', options.resolverDir ?? '/etc/resolver',
    '--http-port', String(options.httpPort ?? 80),
    ...(options.flush === false ? ['--no-flush'] : []),
    ...options.domains,
  ]

  const child = spawn(command[0], args, {
    // stdin pipe：helper 的 EOF 守卫通道；stderr inherit：sudo 提示与 helper 报错直达用户
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  const httpPort = await new Promise<number>((resolvePromise, rejectPromise) => {
    // READY 前的任何退出（含 0 与信号杀）都是失败——helper 就绪前没有正常退出的语义；
    // 超时兜底覆盖 sudo 提示无人响应与 helper 静默挂死（密码输入给了足量时间窗）
    const fail = (why: string) => {
      clearTimeout(timer)
      rejectPromise(new DvError(`helper ${why}——sudo 需要终端可交互；若 :${options.httpPort ?? 80} 被占用请先释放`))
    }
    const timer = setTimeout(() => fail('启动超时'), 180_000)
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = /READY (\d+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        resolvePromise(Number(match[1]))
      }
    }
    child.stdout?.on('data', onData)
    child.on('error', (error) => fail(`启动失败：${error.message}`))
    child.on('exit', (code, signal) => fail(`退出（${signal ?? code ?? 'unknown'}）`))
  })

  return {
    child,
    httpPort,
    stop: () => {
      // 正常关停：结束 stdin 触发 EOF 守卫，helper 自清 resolver 文件后退出
      child.stdin?.end()
    },
  }
}
