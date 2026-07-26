import type { DvHookable } from '../core/hooks.ts'
import type { DvPlugin } from './types.ts'
import { isPluginEnabled, readConfig } from './state.ts'

/**
 * killport 内置插件骨架：先建立注册与状态管理通路，
 * 端口解析与查杀行为由插件实现填充。
 */
export const killportPlugin: DvPlugin = {
  name: 'kp',
  description: 'Kill processes occupying the target dev server port before running a script',
  setup: () => {},
}

/** 内置插件注册表：顺序即 plugins list 的展示顺序 */
export const BUILTIN_PLUGINS: DvPlugin[] = [killportPlugin]

/**
 * 把启用状态的插件挂载到 hooks。禁用插件完全不执行 setup——
 * 不挂载比挂载后跳过更干净：禁用态的插件不应在 hook 链里留下任何痕迹。
 */
export async function registerPlugins(
  hooks: DvHookable,
  plugins: DvPlugin[],
  configPath: string,
): Promise<string[]> {
  const config = await readConfig(configPath)
  const mounted: string[] = []
  for (const plugin of plugins) {
    if (isPluginEnabled(config, plugin.name)) {
      plugin.setup(hooks)
      mounted.push(plugin.name)
    }
  }
  return mounted
}
