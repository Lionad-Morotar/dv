import { describe, expect, it } from 'vitest'

import { resolveColorEnv } from '../src/core/index.ts'

/**
 * resolveColorEnv 决定 spawn 子进程该看到什么颜色相关环境。
 *
 * 取证结论（见 DevGoal）：spawn stdio:'inherit' 虽 dup 父进程 fd，
 * 但子进程 process.stdout 仍是 Node Stream 包装层，且 spawn 默认不注入 FORCE_COLOR，
 * 导致 dev server / 颜色库检测失真而丢色。
 *
 * 注入策略：父进程 stdout 是 TTY 且用户未显式表态（无 NO_COLOR / FORCE_COLOR）时，
 * 注入 FORCE_COLOR=1；用户显式设置一律尊重透传，不覆盖。
 */
describe('resolveColorEnv', () => {
  describe('when parent stdout is a TTY', () => {
    it('injects FORCE_COLOR=1 when the user has expressed no color preference', () => {
      const env = resolveColorEnv({ parentIsTTY: true, env: { PATH: '/usr/bin' } })
      expect(env.FORCE_COLOR).toBe('1')
    })

    it('preserves an explicit NO_COLOR without injecting FORCE_COLOR', () => {
      // NO_COLOR 是跨工具的禁色约定，必须尊重用户禁色意图
      const env = resolveColorEnv({ parentIsTTY: true, env: { NO_COLOR: '1' } })
      expect(env.FORCE_COLOR).toBeUndefined()
      expect(env.NO_COLOR).toBe('1')
    })

    it('preserves an explicit FORCE_COLOR value instead of overwriting it', () => {
      // 用户可能设 FORCE_COLOR=0（强制禁色）或 =3（真彩色），均属显式表态
      for (const value of ['0', '1', '2', '3']) {
        const env = resolveColorEnv({ parentIsTTY: true, env: { FORCE_COLOR: value } })
        expect(env.FORCE_COLOR).toBe(value)
      }
    })
  })

  describe('when parent stdout is not a TTY', () => {
    it('does not inject FORCE_COLOR to avoid polluting output-capturing contexts', () => {
      // pipe / CI 等场景下注入会污染调用方对输出的捕获与解析
      const env = resolveColorEnv({ parentIsTTY: false, env: { PATH: '/usr/bin' } })
      expect(env.FORCE_COLOR).toBeUndefined()
    })

    it('still preserves an explicit user FORCE_COLOR even when not a TTY', () => {
      // 用户显式 FORCE_COLOR 在任何场景都应透传，dv 不越权清除
      const env = resolveColorEnv({ parentIsTTY: false, env: { FORCE_COLOR: '1' } })
      expect(env.FORCE_COLOR).toBe('1')
    })
  })
})
