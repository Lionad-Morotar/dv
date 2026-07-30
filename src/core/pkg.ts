import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** dv 的可预期错误：信息面向终端用户，exit code 恒为 1 */
export class DvError extends Error {}

export interface ProjectPackage {
  dir: string
  name?: string
  scripts: Record<string, string>
  /**
   * 原始 `dv` 配置 key：core 只透传不解释——配置语义归各插件（如 kp 的端口声明），
   * 畸形值由消费方 warn 降级；此处校验并 throw 会让一个插件的配置问题炸掉整个 dv。
   */
  dv?: unknown
}

/**
 * 读取目标目录的 package.json 并提取 scripts。
 * scripts 缺失或为空视为错误——dv 的全部价值建立在 scripts 之上，空集应尽早失败。
 */
export async function readProjectPackage(dir: string): Promise<ProjectPackage> {
  const pkgPath = resolve(dir, 'package.json')

  let rawText: string
  try {
    rawText = await readFile(pkgPath, 'utf8')
  } catch {
    throw new DvError(`package.json not found at ${pkgPath}`)
  }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(rawText)
  } catch {
    throw new DvError(`failed to parse package.json at ${pkgPath}`)
  }

  const scripts = raw.scripts
  if (scripts === undefined || scripts === null) {
    throw new DvError(`no scripts found in ${pkgPath}`)
  }
  if (typeof scripts !== 'object' || Array.isArray(scripts) || Object.keys(scripts).length === 0) {
    throw new DvError(`no scripts found in ${pkgPath}`)
  }

  // 非字符串 script 值会在 spawn 时才以费解方式爆掉，读取时即拦截
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== 'string') {
      throw new DvError(`scripts."${name}" must be a string in ${pkgPath}`)
    }
  }

  return {
    dir,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    scripts: scripts as Record<string, string>,
    dv: raw.dv,
  }
}

/** 供 --path 缺省时回退 cwd 的解析，集中一处便于未来扩展（如向上查找） */
export function resolveProjectDir(cwd: string, path?: string): string {
  return resolve(cwd, path ?? '.')
}

/** 测试替身用的文件存在性探测，避免在 pm 检测中直接绑定 fs 异常路径 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
