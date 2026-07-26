import type { DvHookable } from '../core/hooks.ts'

/**
 * 插件形态：公开注册 API（决策 D13——本期仅内置插件，外部发现机制超出范围，
 * 但任何拿到 DvHookable 的代码都能以同一 API 挂载，无内置特权路径）。
 */
export interface DvPlugin {
  name: string
  /** 插件描述，plugins list 展示用 */
  description?: string
  setup: (hooks: DvHookable) => void
}
