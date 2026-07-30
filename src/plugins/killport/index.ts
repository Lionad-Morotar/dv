import type { DvHookContext } from '../../core/hooks.ts'
import type { DvPlugin } from '../types.ts'
import { extractPortFromConfig, loadFrameworkConfig } from './config.ts'
import { extractDeclaredPort } from './declare.ts'
import { killProcessOnPort } from './kill.ts'
import { parsePortFromScript } from './port.ts'
import { resolveDelegatedScriptText, resolveScriptDir } from './workspace.ts'

/**
 * killport 插件：dev script 执行前清场目标端口上的监听进程。
 * 只在 command:before 介入；解析不到端口时跳过（宁缺不滥，绝不错杀）。
 */
export const killportPlugin: DvPlugin = {
  name: 'kp',
  description: 'Kill processes occupying the target dev server port before running a script',
  setup(hooks) {
    hooks.hook('command:before', async (ctx) => {
      const port = await resolvePort(ctx)
      if (port === null) {
        ctx.logger.info('kp: no port detected, skipping')
        return
      }
      const pids = await killProcessOnPort(port)
      if (pids.length > 0) {
        ctx.logger.info(`kp: killed pid ${pids.join(', ')} on port ${port}`)
      }
    })
  },
}

/**
 * 端口解析链：根 script 显式端口 > 委托 script 显式端口 > 项目声明端口 > 框架 config 静态提取。
 * pnpm -C/--filter 先穿透出执行目录，委托 script 与 config 搜索共用这一个目录——
 * 单一解析路径避免两条兜底语义漂移。monorepo 下端口常声明在子包 script 命令行
 * （nuxt dev --port 2350），命令行在运行时覆盖一切静态来源，故优先级最高；
 * 项目声明（package.json `dv.killport.<script>`）是人类显式写下的静态值，覆盖
 * 框架 config 这类静态推断，但不得覆盖命令行 runtime 真相。
 * --filter 包名无匹配时 resolveScriptDir 判 null：委托失败的命令必然执行失败，
 * 全链跳过（含项目声明），不回落根包搜索，杜绝从无关实体提取端口而错杀。
 */
async function resolvePort(ctx: DvHookContext): Promise<number | null> {
  const { scriptText, scriptName } = ctx
  if (!scriptText || !scriptName) return null
  const fromScript = parsePortFromScript(scriptText)
  if (fromScript !== null) return fromScript
  const configDir = await resolveScriptDir(scriptText, ctx.dir)
  if (configDir === null) return null
  const delegatedText = await resolveDelegatedScriptText(scriptText, configDir)
  if (delegatedText !== null) {
    const fromDelegated = parsePortFromScript(delegatedText)
    if (fromDelegated !== null) return fromDelegated
  }
  const declared = extractDeclaredPort(ctx.pkg, scriptName, ctx.logger)
  if (declared !== null) return declared
  const config = await loadFrameworkConfig(configDir)
  if (config === null) return null
  return extractPortFromConfig(config.code, config.kind)
}
