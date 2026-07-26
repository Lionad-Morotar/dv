import type { DvPlugin } from '../types.ts'
import { killProcessOnPort } from './kill.ts'
import { parsePortFromScript } from './port.ts'

/**
 * killport 插件：dev script 执行前清场目标端口上的监听进程。
 * 只在 command:before 介入；解析不到端口时跳过（宁缺不滥，绝不错杀）。
 */
export const killportPlugin: DvPlugin = {
  name: 'kp',
  description: 'Kill processes occupying the target dev server port before running a script',
  setup(hooks) {
    hooks.hook('command:before', async (ctx) => {
      const port = ctx.scriptText ? parsePortFromScript(ctx.scriptText) : null
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
