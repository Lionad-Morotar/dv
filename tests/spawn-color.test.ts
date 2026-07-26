import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * spawnScript 颜色 env 接线点测试。
 *
 * 决策逻辑本身由 tests/color.test.ts 覆盖（resolveColorEnv 纯函数），
 * 本文件锁定两件事：
 *   1. inherit 模式下 spawn 收到的 env 经 resolveColorEnv 注入 FORCE_COLOR
 *   2. 真实调用形态（run() 不注入流）下 inherit 判定为 true，注入逻辑不是死代码
 *
 * mock 隔离在独立文件，不影响 tests/spawn.test.ts 的真实 spawn 行为验证。
 */

let lastSpawn: { args: string[]; options: SpawnOptions } | null = null
vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], options: SpawnOptions): ChildProcess => {
    lastSpawn = { args: [cmd, ...args], options }
    const fake = {
      on: (event: string, cb: (...a: unknown[]) => void) => {
        if (event === 'exit') setImmediate(() => cb(0, null))
      },
      kill: () => {},
      stdout: null,
      stderr: null,
      stdin: null,
    }
    return fake as unknown as ChildProcess
  },
}))

const { spawnScript } = await import('../src/core/index.ts')
const { run } = await import('../src/run.ts')

afterEach(() => {
  lastSpawn = null
})

const fixtures = {
  basic: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
}

describe('spawnScript color env wiring', () => {
  it('injects FORCE_COLOR=1 into the spawned env when parent stdout is a TTY', async () => {
    // colorTTY=true 模拟真实终端场景；决策细节由 resolveColorEnv 单测保证
    await spawnScript('npm', 'dev', { cwd: fixtures.basic, colorTTY: true })
    expect(lastSpawn).not.toBeNull()
    expect(lastSpawn!.options.env?.FORCE_COLOR).toBe('1')
  })

  it('does not inject FORCE_COLOR when parent stdout is not a TTY', async () => {
    await spawnScript('npm', 'dev', { cwd: fixtures.basic, colorTTY: false })
    expect(lastSpawn).not.toBeNull()
    expect(lastSpawn!.options.env?.FORCE_COLOR).toBeUndefined()
  })

  it('respects an explicit NO_COLOR even when parent is a TTY', async () => {
    process.env.NO_COLOR = '1'
    try {
      await spawnScript('npm', 'dev', { cwd: fixtures.basic, colorTTY: true })
      expect(lastSpawn!.options.env?.FORCE_COLOR).toBeUndefined()
      expect(lastSpawn!.options.env?.NO_COLOR).toBe('1')
    } finally {
      delete process.env.NO_COLOR
    }
  })
})

describe('run() real-path color wiring', () => {
  it('injects FORCE_COLOR when run() is called without injected streams (real terminal form)', async () => {
    // 真实调用形态：cli.ts 调 run() 不传 stdin/stdout/stderr。
    // run() 不得用 ?? process.stdout 兜底传给 spawnScript——那会让 inherit 恒为 false，
    // 使注入逻辑变成死代码（kimi-k3 审查发现的高严重度问题）。
    // colorTTY=true 模拟真实终端的 process.stdout.isTTY===true。
    await run('dev', { path: fixtures.basic, colorTTY: true })
    expect(lastSpawn).not.toBeNull()
    expect(lastSpawn!.options.env?.FORCE_COLOR).toBe('1')
  })

  it('falls back to pipe mode (no FORCE_COLOR) when run() is called with injected streams', async () => {
    // 测试 / 捕获输出场景：注入流 → pipe 模式 → 不注入 FORCE_COLOR
    const { Writable } = await import('node:stream')
    const capture = new Writable({ write: (_c, _e, cb) => cb() })
    await run('dev', { path: fixtures.basic, stdout: capture, stderr: capture })
    expect(lastSpawn).not.toBeNull()
    expect(lastSpawn!.options.env?.FORCE_COLOR).toBeUndefined()
  })
})
