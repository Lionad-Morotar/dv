import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createHooks } from 'hookable'

import type { DvHooks } from '../src/core/hooks.ts'
import { run } from '../src/run.ts'
import { BUILTIN_PLUGINS, registerPlugins } from '../src/plugins/registry.ts'
import { setPluginEnabled } from '../src/plugins/state.ts'
import { CaptureStream, exitOf, freshConfigPath, occupyPort } from './helpers.ts'

const BIND_PORT = 53992
const basic = fileURLToPath(new URL('./fixtures/basic', import.meta.url))

describe('kp plugin integration', () => {
  it('kills the occupying process before running the script', async () => {
    const child = await occupyPort(BIND_PORT)
    const exited = exitOf(child)

    const out = new CaptureStream()
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('db', { path: basic, hooks, stdout: out, stderr: out })

    expect(code).toBe(0)
    expect(out.text).toContain('BIND_OK')
    expect(out.text).toContain(`kp: killed pid ${child.pid} on port ${BIND_PORT}`)
    expect((await exited).signal).toBe('SIGTERM')
  }, 15000)

  it('does not intervene when kp is disabled', async () => {
    const child = await occupyPort(BIND_PORT)
    try {
      const out = new CaptureStream()
      const hooks = createHooks<DvHooks>()
      const configPath = await freshConfigPath()
      await setPluginEnabled(configPath, 'kp', false)
      const mounted = await registerPlugins(hooks, BUILTIN_PLUGINS, configPath)
      expect(mounted).toEqual([])

      const code = await run('db', { path: basic, hooks, stdout: out, stderr: out })

      expect(code).toBe(1)
      expect(out.text).toContain('BIND_FAIL')
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill('SIGTERM')
    }
  }, 15000)

  it('skips port handling when the script declares no port', async () => {
    const out = new CaptureStream()
    const logs: string[] = []
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('dev', {
      path: basic,
      hooks,
      stdout: out,
      stderr: out,
      logger: {
        info: (m) => { logs.push(m) },
        warn: (m) => { logs.push(m) },
      },
    })

    expect(code).toBe(0)
    expect(out.text).toContain('DEV_RAN')
    expect(logs).toContain('kp: no port detected, skipping')
  })
})
