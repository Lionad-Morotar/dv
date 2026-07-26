import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

import type { PackageManager } from './pm.ts'
import { DvError } from './pkg.ts'

export interface SpawnScriptOptions {
  cwd: string
  stdin?: Readable
  stdout?: Writable
  stderr?: Writable
}

/**
 * 以 `<pm> run <scriptName>` 执行 script 并忠实透传：
 * 未注入流时 stdio 整体继承父进程（保留 TTY——dev server 的颜色与光标控制依赖它）；
 * 注入流时降级为 pipe 转发（调用方需要捕获输出的场景，如测试）。
 * 退出码透传为返回值；SIGINT 显式转发子进程并等待其退出——
 * 直接退出父进程会让子进程变成孤儿继续占用端口。
 */
export async function spawnScript(
  pm: PackageManager,
  scriptName: string,
  options: SpawnScriptOptions,
): Promise<number> {
  const { cwd, stdin, stdout, stderr } = options
  const inherit = stdin === undefined && stdout === undefined && stderr === undefined

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pm, ['run', scriptName], {
      cwd,
      stdio: inherit ? 'inherit' : 'pipe',
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
