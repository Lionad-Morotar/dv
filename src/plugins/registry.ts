import type { DvHookable } from '../core/hooks.ts'
import type { DvPlugin } from './types.ts'
import { killportPlugin } from './killport/index.ts'
import { isPluginEnabled, readConfig } from './state.ts'

export { killportPlugin }

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
