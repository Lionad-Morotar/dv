import type { DvLogger } from '../../core/hooks.ts'
import type { ProjectPackage } from '../../core/pkg.ts'

/**
 * 项目级显式端口声明：package.json 的 `dv.killport.<scriptName>`。
 * 为命令行无端口、无框架 config 的 script（如 `cd backend && air`——端口藏在
 * 运行时 env 里）提供可信来源；key 按解析后的全 script 名匹配（用户输入的
 * 缩写/模糊形态无穷，声明必须锚定唯一实体）。
 * 畸形声明 warn 并视为未声明——配置问题绝不阻断 dev script 启动（宁缺不滥）；
 * 但静默吞掉会让用户困惑"为何不生效"，故必须 warn。
 */
export function extractDeclaredPort(
  pkg: ProjectPackage,
  scriptName: string,
  logger: DvLogger,
): number | null {
  const dv = pkg.dv
  if (dv === undefined || dv === null) return null
  if (typeof dv !== 'object' || Array.isArray(dv)) {
    logger.warn('kp: ignoring invalid "dv" config in package.json (expected object)')
    return null
  }
  const killport = (dv as { killport?: unknown }).killport
  if (killport === undefined || killport === null) return null
  if (typeof killport !== 'object' || Array.isArray(killport)) {
    logger.warn('kp: ignoring invalid "dv.killport" config in package.json (expected object)')
    return null
  }
  const declared = (killport as Record<string, unknown>)[scriptName]
  if (declared === undefined || declared === null) return null
  if (
    typeof declared !== 'number' ||
    !Number.isInteger(declared) ||
    declared < 1 ||
    declared > 65535
  ) {
    logger.warn(`kp: ignoring invalid declared port for "${scriptName}" (expected integer 1-65535)`)
    return null
  }
  return declared
}
