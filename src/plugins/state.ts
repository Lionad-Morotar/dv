import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

/**
 * 插件启用状态持久化（决策 D12/D17）：用户级 ~/.config/dv/config.json，
 * 结构 { plugins: { <name>: { enabled } } }。
 * 文件缺失或损坏一律回退「全部启用」——配置文件是易损面，绝不让它成为 CLI 的崩溃源。
 */

export interface DvConfig {
  plugins: Record<string, { enabled: boolean }>
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  // 用 || 而非 ??：XDG_CONFIG_HOME 为空字符串（已 export 但无值）时 ?? 不兜底，
  // 会把配置目录解析成相对路径 ./dv 写到任意 cwd 下
  const xdg = env.XDG_CONFIG_HOME
  return join(xdg || join(homedir(), '.config'), 'dv', 'config.json')
}

export async function readConfig(configPath: string): Promise<DvConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath, 'utf8'))
    const plugins =
      raw !== null && typeof raw === 'object' && raw.plugins !== null && typeof raw.plugins === 'object'
        ? (raw.plugins as DvConfig['plugins'])
        : {}
    return { plugins }
  } catch {
    // 缺失/损坏回退默认（全部启用）
    return { plugins: {} }
  }
}

export async function writeConfig(configPath: string, config: DvConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export function isPluginEnabled(config: DvConfig, name: string): boolean {
  return config.plugins[name]?.enabled ?? true
}

export async function setPluginEnabled(
  configPath: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  const config = await readConfig(configPath)
  config.plugins[name] = { enabled }
  await writeConfig(configPath, config)
}
