/**
 * spawn 子进程颜色环境决策：纯函数，不触 process.* ——
 * 读取侧（spawnScript）把 parentIsTTY / env 作为显式参数注入，
 * 使决策逻辑可表驱动单测，不被真实运行环境绑架。
 */

export interface ResolveColorEnvInput {
  /** 父进程 stdout 是否 TTY；非 TTY 时不主动注入，避免污染输出捕获场景 */
  parentIsTTY: boolean
  /** 父进程环境变量，用户显式设置一律尊重透传 */
  env: Record<string, string | undefined>
}

/**
 * 决定 spawn 子进程该看到什么颜色相关环境。
 *
 * 取证结论：spawn stdio:'inherit' 虽 dup 父进程 fd，但子进程 process.stdout
 * 仍是 Node Stream 包装层，且 spawn 默认不注入 FORCE_COLOR，导致 dev server /
 * 颜色库检测失真而丢色。修复策略：父进程是 TTY 且用户未显式表态时注入 FORCE_COLOR=1。
 *
 * 优先级（与 chalk / picocolors / supports-color 业界约定一致）：
 *   1. 用户显式 FORCE_COLOR —— 透传，不覆盖（=0 强制禁色 / =1..3 显式启用真彩色）
 *   2. 用户显式 NO_COLOR —— 尊重禁色意图，不注入 FORCE_COLOR
 *   3. 父进程非 TTY —— 不主动注入（pipe / CI 捕获输出场景）
 *   4. 父进程是 TTY 且无表态 —— 注入 FORCE_COLOR=1
 */
export function resolveColorEnv({ parentIsTTY, env }: ResolveColorEnvInput): Record<string, string | undefined> {
  const next = { ...env }

  const hasForceColor = env.FORCE_COLOR !== undefined
  const hasNoColor = env.NO_COLOR !== undefined

  if (hasForceColor || hasNoColor || !parentIsTTY) {
    return next
  }

  next.FORCE_COLOR = '1'
  return next
}
