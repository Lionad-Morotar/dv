import type { DvHookContext } from '../../core/hooks.ts'
import type { DvPlugin } from '../types.ts'
import { extractPortFromConfig, loadFrameworkConfig } from './config.ts'
import { killProcessOnPort } from './kill.ts'
import { parsePortFromScript } from './port.ts'
import { resolveScriptDir } from './workspace.ts'

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
 * 端口解析链：script 文本显式端口 > 框架 config 静态提取。
 * config 搜索目录经 pnpm -C/--filter 穿透——monorepo 下端口声明在子包的 config 里。
 */
async function resolvePort(ctx: DvHookContext): Promise<number | null> {
  if (!ctx.scriptText) return null
  const fromScript = parsePortFromScript(ctx.scriptText)
  if (fromScript !== null) return fromScript
  const configDir = await resolveScriptDir(ctx.scriptText, ctx.dir)
  const config = await loadFrameworkConfig(configDir)
  if (config === null) return null
  return extractPortFromConfig(config.code, config.kind)
}
