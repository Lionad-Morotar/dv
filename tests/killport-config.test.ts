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
const APP_PORT = 53995
const CFG_SCRIPT_PORT = 53997
const ROOT_CONFIG_PORT = 53998
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

  it.skipIf(!hasPnpm)('extracts the port from the delegated workspace package script', async () => {
    const child = await occupyPort(APP_PORT)
    const exited = exitOf(child)

    const out = new CaptureStream()
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('dev:app', { path: monorepo, hooks, stdout: out, stderr: out })

    expect(code).toBe(0)
    expect(out.text).toContain('APP_RAN')
    expect(out.text).toContain(`kp: killed pid ${child.pid} on port ${APP_PORT}`)
    expect((await exited).signal).toBe('SIGTERM')
  }, 20000)

  it.skipIf(!hasPnpm)('does not fall back to the root config when --filter matches nothing', async () => {
    // 根包 vite.config 声明 53998、dev:ghost 的 filter 无匹配：委托失败的命令
    // 必然执行失败，kp 回落根包 config 会错杀 53998 上的无辜进程
    const child = await occupyPort(ROOT_CONFIG_PORT)
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

  it.skipIf(!hasPnpm)('prefers the delegated script port over the package config port', async () => {
    // cfg 包 script 声明 53997、vite.config 声明 53996：kp 取错端口则占用进程存活，
    // server.cjs 绑定 53997 撞占用而 APP_FAIL，exit code 非 0
    const child = await occupyPort(CFG_SCRIPT_PORT)
    const exited = exitOf(child)

    const out = new CaptureStream()
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, await freshConfigPath())

    const code = await run('dev:cfg', { path: monorepo, hooks, stdout: out, stderr: out })

    expect(code).toBe(0)
    expect(out.text).toContain('CFG_RAN')
    expect(out.text).toContain(`kp: killed pid ${child.pid} on port ${CFG_SCRIPT_PORT}`)
    expect((await exited).signal).toBe('SIGTERM')
  }, 20000)
})
