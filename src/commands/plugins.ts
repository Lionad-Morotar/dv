import type { Writable } from 'node:stream'

import type { DvPlugin } from '../plugins/types.ts'
import { BUILTIN_PLUGINS } from '../plugins/registry.ts'
import { isPluginEnabled, readConfig, resolveConfigPath, setPluginEnabled } from '../plugins/state.ts'

export interface PluginsCommandOptions {
  /** 测试注入：配置路径，缺省走用户级 ~/.config/dv/config.json */
  configPath?: string
  /** 测试注入：插件注册表，缺省内置表 */
  plugins?: DvPlugin[]
  stdout?: Writable
  stderr?: Writable
}

const SUBCOMMANDS = ['list', 'enable', 'disable'] as const

/**
 * `dv plugins <list|enable|disable> [name]`：插件状态管理。
 * list 不写配置、enable/disable 落盘后立即生效于下一次 dv 调用。
 */
export async function pluginsCommand(
  sub: string,
  name: string | undefined,
  options: PluginsCommandOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const plugins = options.plugins ?? BUILTIN_PLUGINS
  const configPath = options.configPath ?? resolveConfigPath()

  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    stderr.write(`dv: unknown plugins subcommand "${sub}". Available: ${SUBCOMMANDS.join(', ')}\n`)
    return 1
  }

  if (sub === 'list') {
    const config = await readConfig(configPath)
    for (const plugin of plugins) {
      const state = isPluginEnabled(config, plugin.name) ? 'enabled' : 'disabled'
      stdout.write(`  ${plugin.name}  ${state}${plugin.description ? `  ${plugin.description}` : ''}\n`)
    }
    return 0
  }

  if (name === undefined) {
    stderr.write(`dv: plugins ${sub} requires a plugin name. Known: ${plugins.map((p) => p.name).join(', ')}\n`)
    return 1
  }

  if (!plugins.some((p) => p.name === name)) {
    stderr.write(`dv: unknown plugin "${name}". Known: ${plugins.map((p) => p.name).join(', ')}\n`)
    return 1
  }

  await setPluginEnabled(configPath, name, sub === 'enable')
  stdout.write(`  ${name} ${sub === 'enable' ? 'enabled' : 'disabled'}\n`)
  return 0
}
