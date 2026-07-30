import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHooks } from 'hookable'

import type { DvHooks } from '../src/core/hooks.ts'
import { run } from '../src/run.ts'
import { extractDeclaredPort } from '../src/plugins/killport/declare.ts'
import { BUILTIN_PLUGINS, registerPlugins } from '../src/plugins/registry.ts'
import { CaptureStream, exitOf, freshConfigPath, occupyPort } from './helpers.ts'

const execFileAsync = promisify(execFile)
const hasPnpm = await execFileAsync('pnpm', ['--version']).then(
  () => true,
  () => false,
)

const DECLARED_PORT = 54000
const EXPLICIT_PORT = 54002
const DECLARED_OVER_CFG_PORT = 54007
const DELEGATED_PORT = 54005
const GHOST_DECLARED_PORT = 54004
const declareProj = fileURLToPath(new URL('./fixtures/declare', import.meta.url))
const declareCfgProj = fileURLToPath(new URL('./fixtures/declare-cfg', import.meta.url))
const monorepo = fileURLToPath(new URL('./fixtures/monorepo', import.meta.url))

describe('extractDeclaredPort (unit)', () => {
  const silent = { info: () => {}, warn: () => {} }

  function pkgWith(dv: unknown) {
    return { dir: '/x', scripts: { dev: 'true' }, dv }
  }

  it('returns the declared port for a valid declaration', () => {
    const warns: string[] = []
    const port = extractDeclaredPort(pkgWith({ killport: { dev: 8889 } }), 'dev', {
      ...silent,
      warn: (m) => warns.push(m),
    })
    expect(port).toBe(8889)
    expect(warns).toEqual([])
  })

  it('returns null silently when no dv config exists', () => {
    const warns: string[] = []
    expect(extractDeclaredPort(pkgWith(undefined), 'dev', { ...silent, warn: (m) => warns.push(m) })).toBeNull()
    expect(extractDeclaredPort(pkgWith({}), 'dev', { ...silent, warn: (m) => warns.push(m) })).toBeNull()
    expect(extractDeclaredPort(pkgWith({ killport: {} }), 'dev', { ...silent, warn: (m) => warns.push(m) })).toBeNull()
    expect(warns).toEqual([])
  })

  it('warns and returns null when dv is not an object', () => {
    const warns: string[] = []
    expect(extractDeclaredPort(pkgWith(5), 'dev', { ...silent, warn: (m) => warns.push(m) })).toBeNull()
    expect(warns).toEqual(['kp: ignoring invalid "dv" config in package.json (expected object)'])
  })

  it('warns and returns null when killport is not an object', () => {
    const warns: string[] = []
    expect(extractDeclaredPort(pkgWith({ killport: [] }), 'dev', { ...silent, warn: (m) => warns.push(m) })).toBeNull()
    expect(warns).toEqual(['kp: ignoring invalid "dv.killport" config in package.json (expected object)'])
  })

  it('warns and returns null when the declared port is not an integer in range', () => {
    const warns: string[] = []
    const logger = { ...silent, warn: (m: string) => warns.push(m) }
    expect(extractDeclaredPort(pkgWith({ killport: { dev: 80.5 } }), 'dev', logger)).toBeNull()
    expect(extractDeclaredPort(pkgWith({ killport: { dev: 0 } }), 'dev', logger)).toBeNull()
    expect(warns).toHaveLength(2)
  })
})

describe('kp project-declared port', () => {
  it('kills the process on the declared port when the script declares none', async () => {
    const child = await occupyPort(DECLARED_PORT)
    const exited = exitOf(child)

    const out = new CaptureStream()
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('dev', { path: declareProj, hooks, stdout: out, stderr: out })

    expect(code).toBe(0)
    expect(out.text).toContain('DECLARED_RAN')
    expect(out.text).toContain(`kp: killed pid ${child.pid} on port ${DECLARED_PORT}`)
    expect((await exited).signal).toBe('SIGTERM')
  }, 15000)

  it('prefers the script command-line port over the declared port', async () => {
    // dev:explicit 命令行 PORT=54002（runtime 真相）、声明 54001（静态值）：
    // 取错端口则 54002 占用者存活，script 绑定撞占用而 EXPLICIT_FAIL、exit code 非 0
    const child = await occupyPort(EXPLICIT_PORT)
    const exited = exitOf(child)

    const out = new CaptureStream()
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('dev:explicit', { path: declareProj, hooks, stdout: out, stderr: out })

    expect(code).toBe(0)
    expect(out.text).toContain('EXPLICIT_RAN')
    expect(out.text).toContain(`kp: killed pid ${child.pid} on port ${EXPLICIT_PORT}`)
    expect((await exited).signal).toBe('SIGTERM')
  }, 15000)

  it('prefers the declared port over the framework config port', async () => {
    // 声明 54007（人类显式）、vite.config server.port 54006（静态推断）：
    // 取 config 则 54007 无 killed 日志；取声明则占用者被 SIGTERM
    const child = await occupyPort(DECLARED_OVER_CFG_PORT)
    const exited = exitOf(child)

    const out = new CaptureStream()
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('dev', { path: declareCfgProj, hooks, stdout: out, stderr: out })

    expect(code).toBe(0)
    expect(out.text).toContain('DECLARE_CFG_RAN')
    expect(out.text).toContain(`kp: killed pid ${child.pid} on port ${DECLARED_OVER_CFG_PORT}`)
    expect((await exited).signal).toBe('SIGTERM')
  }, 15000)

  it('warns and falls through on a non-numeric declared port', async () => {
    // 声明 "not-a-port"：warn 让用户知道配置没被采纳，随后按无声明继续链式回落，
    // 不得 throw——配置问题不能阻断 dev script 启动
    const out = new CaptureStream()
    const logs: string[] = []
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('dev:bad-str', {
      path: declareProj,
      hooks,
      stdout: out,
      stderr: out,
      logger: {
        info: (m) => { logs.push(m) },
        warn: (m) => { logs.push(m) },
      },
    })

    expect(code).toBe(0)
    expect(out.text).toContain('BADSTR_RAN')
    expect(logs).toContain('kp: ignoring invalid declared port for "dev:bad-str" (expected integer 1-65535)')
    expect(logs).toContain('kp: no port detected, skipping')
  })

  it('warns and falls through on an out-of-range declared port', async () => {
    const out = new CaptureStream()
    const logs: string[] = []
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('dev:bad-range', {
      path: declareProj,
      hooks,
      stdout: out,
      stderr: out,
      logger: {
        info: (m) => { logs.push(m) },
        warn: (m) => { logs.push(m) },
      },
    })

    expect(code).toBe(0)
    expect(out.text).toContain('BADRANGE_RAN')
    expect(logs).toContain('kp: ignoring invalid declared port for "dev:bad-range" (expected integer 1-65535)')
    expect(logs).toContain('kp: no port detected, skipping')
  })

  it.skipIf(!hasPnpm)('prefers the delegated script port over the declared port', async () => {
    // dev:dlg 委托到 @test/dlg 的 `node server.cjs --port 54005`（runtime 真相）、
    // 根包声明 dev:dlg=54008（静态值）：取声明则 54005 占用者存活、server 绑定失败
    const child = await occupyPort(DELEGATED_PORT)
    const exited = exitOf(child)

    const out = new CaptureStream()
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('dev:dlg', { path: monorepo, hooks, stdout: out, stderr: out })

    expect(code).toBe(0)
    expect(out.text).toContain('DLG_RAN')
    expect(out.text).toContain(`kp: killed pid ${child.pid} on port ${DELEGATED_PORT}`)
    expect((await exited).signal).toBe('SIGTERM')
  }, 20000)

  it.skipIf(!hasPnpm)('does not consult the declaration when the delegation fails', async () => {
    // dev:ghost 的 --filter 无匹配：委托失败的命令必然执行失败，整链跳过（含项目声明）——
    // 若声明被查，54004 上的无辜进程会被错杀
    const child = await occupyPort(GHOST_DECLARED_PORT)
    try {
      const out = new CaptureStream()
      const hooks = createHooks<DvHooks>()
      await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

      await run('dev:ghost', { path: monorepo, hooks, stdout: out, stderr: out })

      expect(out.text).toContain('kp: no port detected, skipping')
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill('SIGTERM')
    }
  }, 20000)
})
