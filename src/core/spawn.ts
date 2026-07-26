import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

import type { PackageManager } from './pm.ts'
import { DvError } from './pkg.ts'
import { resolveColorEnv } from './color.ts'

export interface SpawnScriptOptions {
  cwd: string
  stdin?: Readable
  stdout?: Writable
  stderr?: Writable
  /**
   * 父进程 stdout 是否 TTY，决定是否向子进程注入 FORCE_COLOR。
   * 缺省读 process.stdout.isTTY；测试可显式注入以脱离真实运行环境。
   * 仅在 inherit 模式（未注入流）下生效——pipe 模式调用方捕获输出，不应被改色。
   */
  colorTTY?: boolean
}

/**
 * 以 `<pm> run <scriptName>` 执行 script 并忠实透传：
 * 未注入流时 stdio 整体继承父进程（保留 TTY——dev server 的颜色与光标控制依赖它）；
 * 注入流时降级为 pipe 转发（调用方需要捕获输出的场景，如测试）。
 * 退出码透传为返回值；SIGINT 显式转发子进程并等待其退出——
 * 直接退出父进程会让子进程变成孤儿继续占用端口。
 *
 * inherit 模式下额外经 resolveColorEnv 注入 FORCE_COLOR：spawn 默认不注入，
 * 而 inherit dup 的 fd 在子进程侧仍是 Node Stream 包装层，部分颜色库 / dev server
 * 检测会失真而丢色。注入策略尊重既有 NO_COLOR / FORCE_COLOR 用户设置。
 */
export async function spawnScript(
  pm: PackageManager,
  scriptName: string,
  options: SpawnScriptOptions,
): Promise<number> {
  const { cwd, stdin, stdout, stderr, colorTTY } = options
  const inherit = stdin === undefined && stdout === undefined && stderr === undefined

  // 仅 inherit 模式注入颜色 env：pipe 模式下调用方在捕获输出，改色会污染解析
  const env =
    inherit && (colorTTY ?? process.stdout.isTTY === true)
      ? resolveColorEnv({ parentIsTTY: true, env: process.env as Record<string, string | undefined> })
      : process.env

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pm, ['run', scriptName], {
      cwd,
      stdio: inherit ? 'inherit' : 'pipe',
      env,
    })

    if (!inherit) {
      child.stdout?.pipe(stdout ?? process.stdout)
      child.stderr?.pipe(stderr ?? process.stderr)
      if (child.stdin) {
        if (stdin) {
          // pipe 默认行为即源流 end 时 end 子进程 stdin（script 收 EOF），正是所需；不额外干预
          stdin.pipe(child.stdin)
        } else {
          child.stdin.end()
        }
      }
    }

    const forwardSigint = () => {
      child.kill('SIGINT')
    }
    process.on('SIGINT', forwardSigint)

    child.on('error', (error) => {
      process.off('SIGINT', forwardSigint)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // pm 未安装是用户可自愈的环境问题，必须给可操作的提示而非 stack trace
        rejectPromise(
          new DvError(`failed to start "${pm}": command not found. Is ${pm} installed and on PATH?`),
        )
      } else {
        rejectPromise(error)
      }
    })

    child.on('exit', (code, signal) => {
      process.off('SIGINT', forwardSigint)
      // 子进程被信号杀死时以 128 + 信号值约定退出，保持与 shell 行为一致
      resolvePromise(code ?? (signal === 'SIGINT' ? 130 : 1))
    })
  })
}
