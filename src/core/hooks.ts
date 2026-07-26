import type { Hookable } from 'hookable'

import type { ProjectPackage } from './pkg.ts'

/** 插件可见的输出面：统一走 stderr，避免污染 script stdout 的管道场景 */
export interface DvLogger {
  info: (msg: string) => void
  warn: (msg: string) => void
}

/**
 * 命令生命周期上下文：随 run 流程逐段填充，各 hook 读到的是当前阶段的快照。
 * scriptName/scriptText 在 command:resolved 后必有值；exitCode 仅 after；error 仅 error。
 */
export interface DvHookContext {
  dir: string
  pkg: ProjectPackage
  mode: string
  scriptName?: string
  scriptText?: string
  exitCode?: number
  error?: Error
  logger: DvLogger
}

export interface DvHooks {
  'scripts:loaded': (ctx: DvHookContext) => void | Promise<void>
  'command:resolved': (ctx: DvHookContext) => void | Promise<void>
  'command:before': (ctx: DvHookContext) => void | Promise<void>
  'command:after': (ctx: DvHookContext) => void | Promise<void>
  'command:error': (ctx: DvHookContext) => void | Promise<void>
}

export type DvHookable = Hookable<DvHooks>
