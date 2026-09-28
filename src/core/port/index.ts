import type { DvHookContext } from '../hooks.ts'
import { extractPortFromConfig, loadFrameworkConfig } from './config.ts'
import { extractDeclaredPort } from './declare.ts'
import { parsePortFromScript } from './port.ts'
import { parsePnpmDirFlag, resolveDelegatedScriptText, resolveScriptDir } from './workspace.ts'

export { extractPortFromConfig, loadFrameworkConfig } from './config.ts'
export { extractDeclaredPort } from './declare.ts'
export { parsePortFromScript } from './port.ts'
export {
  parsePnpmDirFlag,
  parsePnpmScriptName,
  parseWorkspaceGlobs,
  resolveDelegatedScriptText,
  resolveScriptDir,
  resolveWorkspacePackageDir,
} from './workspace.ts'
export type { PnpmDirFlag } from './workspace.ts'

/**
 * 端口解析链：根 script 显式端口 > 委托 script 显式端口 > 项目声明端口 > 框架 config 静态提取。
 * pnpm -C/--filter 先穿透出执行目录，委托 script 与 config 搜索共用这一个目录——
 * 单一解析路径避免两条兜底语义漂移。monorepo 下端口常声明在子包 script 命令行
 * （nuxt dev --port 2350），命令行在运行时覆盖一切静态来源，故优先级最高；
 * 项目声明（package.json `dv.killport.<script>`）是人类显式写下的静态值，覆盖
 * 框架 config 这类静态推断，但不得覆盖命令行 runtime 真相。
 * --filter 包名无匹配时 resolveScriptDir 判 null：委托失败的命令必然执行失败，
 * 全链跳过（含项目声明），不回落根包搜索，杜绝从无关实体提取端口而错杀。
 *
 * 同包 alias（如 `pnpm dev:playground`）再委托到 `--filter/-C` 时，用委托文本重解
 * 目录并最多再读一层子包 script（共两跳 script 文本，不递归更深）——覆盖
 * use-scrollbar `dev → pnpm --filter playground` 这类合法写法。
 *
 * kp 与 bind 共用本链：kp 解析不到端口时跳过（宁缺不滥），
 * bind 解析不到端口则必须报错——静默语义归消费方决定，本链只返回事实。
 */
export async function resolvePort(ctx: DvHookContext): Promise<number | null> {
  const { scriptText, scriptName } = ctx
  if (!scriptText || !scriptName) return null
  const fromScript = parsePortFromScript(scriptText)
  if (fromScript !== null) return fromScript
  let configDir = await resolveScriptDir(scriptText, ctx.dir)
  if (configDir === null) return null
  const delegatedText = await resolveDelegatedScriptText(scriptText, configDir)
  if (delegatedText !== null) {
    const fromDelegated = parsePortFromScript(delegatedText)
    if (fromDelegated !== null) return fromDelegated

    // 同包 alias 的委托文本常是 `pnpm --filter pkg dev`：重解目录，否则 config 仍搜根包
    const piercedDir = await resolveScriptDir(delegatedText, configDir)
    if (piercedDir === null) {
      // 委托文本含目录指示但解析失败 → 与直接 filter 失败同语义，整链跳过
      if (parsePnpmDirFlag(delegatedText) !== null) return null
    } else if (piercedDir !== configDir) {
      configDir = piercedDir
      const nestedText = await resolveDelegatedScriptText(delegatedText, piercedDir)
      if (nestedText !== null) {
        const fromNested = parsePortFromScript(nestedText)
        if (fromNested !== null) return fromNested
      }
    }
  }
  const declared = extractDeclaredPort(ctx.pkg, scriptName, ctx.logger)
  if (declared !== null) return declared
  const config = await loadFrameworkConfig(configDir)
  if (config === null) return null
  return extractPortFromConfig(config.code, config.kind)
}
