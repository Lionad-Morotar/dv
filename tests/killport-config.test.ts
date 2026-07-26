import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createHooks } from 'hookable'

import type { DvHooks } from '../src/core/hooks.ts'
import { run } from '../src/run.ts'
import { BUILTIN_PLUGINS, registerPlugins } from '../src/plugins/registry.ts'
import { CaptureStream, exitOf, freshConfigPath, occupyPort } from './helpers.ts'

const execFileAsync = promisify(execFile)
const hasPnpm = await execFileAsync('pnpm', ['--version']).then(
  () => true,
  () => false,
)

const VITE_PORT = 53994
const MONO_PORT = 53993
const viteproj = fileURLToPath(new URL('./fixtures/viteproj', import.meta.url))
const monorepo = fileURLToPath(new URL('./fixtures/monorepo', import.meta.url))

describe('kp config extraction', () => {
  it('falls back to vite.config port when the script declares none', async () => {
    const child = await occupyPort(VITE_PORT)
    const exited = exitOf(child)

    const out = new CaptureStream()
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('dev', { path: viteproj, hooks, stdout: out, stderr: out })

    expect(code).toBe(0)
    expect(out.text).toContain('VITE_RAN')
    expect(out.text).toContain(`kp: killed pid ${child.pid} on port ${VITE_PORT}`)
    expect((await exited).signal).toBe('SIGTERM')
  }, 15000)

  it.skipIf(!hasPnpm)('penetrates pnpm --filter into the workspace package config', async () => {
    const child = await occupyPort(MONO_PORT)
    const exited = exitOf(child)

    const out = new CaptureStream()
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('dev:filtered', { path: monorepo, hooks, stdout: out, stderr: out })

    expect(code).toBe(0)
    expect(out.text).toContain('WEB_RAN')
    expect(out.text).toContain(`kp: killed pid ${child.pid} on port ${MONO_PORT}`)
    expect((await exited).signal).toBe('SIGTERM')
  }, 20000)

  it.skipIf(!hasPnpm)('penetrates pnpm -C into the subdirectory config', async () => {
    const child = await occupyPort(MONO_PORT)
    const exited = exitOf(child)

    const out = new CaptureStream()
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('dev:chdir', { path: monorepo, hooks, stdout: out, stderr: out })

    expect(code).toBe(0)
    expect(out.text).toContain('WEB_RAN')
    expect(out.text).toContain(`kp: killed pid ${child.pid} on port ${MONO_PORT}`)
    expect((await exited).signal).toBe('SIGTERM')
  }, 20000)
})
