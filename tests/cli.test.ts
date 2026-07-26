import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

const fixtures = {
  basic: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
}

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

/** spawn 真实 node 进程跑 CLI（type stripping 直跑 src），行为级验证入口 */
function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliPath, ...args])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('exit', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

describe('dv cli', () => {
  it('--version prints the package version', async () => {
    const result = await runCli(['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/)
  })

  it('--help prints usage with global options and plugins command', async () => {
    const result = await runCli(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('--path')
    expect(result.stdout).toContain('--mode')
    expect(result.stdout).toContain('plugins')
    expect(result.stdout).toMatch(/list.*enable.*disable/s)
  })

  it('prints help when invoked without arguments', async () => {
    const result = await runCli([])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('--path')
  })

  it('plugins --help prints the plugins usage line', async () => {
    const result = await runCli(['plugins', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('dv plugins [sub]')
  })

  it('bare `plugins` defaults to list instead of a CACError stack', async () => {
    const result = await runCli(['plugins'])
    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain('CACError')
    expect(result.stdout).toContain('kp')
  })

  it('routes unknown words into script matching instead of "unknown command"', async () => {
    const result = await runCli(['foobar', '--path', fixtures.basic])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no script matching "foobar"')
  })

  it('forwards SIGINT to the script process and exits 130', async () => {
    const child = spawn(process.execPath, [cliPath, 'dev:hang', '--path', fixtures.basic])
    // exit 监听必须先注册：进程若在等待窗口内提前退出，后注册的 listener 永远等不到已发射的事件
    const exited = new Promise<number | null>((r) => child.on('exit', r))
    // 事件假设替代时间假设：等 fixture script 的 readiness marker 出现再发信号，
    // 避免慢机器上信号打到尚未就绪的进程树造成的 flaky
    let stdout = ''
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('HANG_READY marker timeout')), 10000)
      child.stdout.on('data', (d) => {
        stdout += d
        if (stdout.includes('HANG_READY')) {
          clearTimeout(timer)
          resolvePromise()
        }
      })
    })
    child.kill('SIGINT')
    expect(await exited).toBe(130)
  }, 15000)
})
