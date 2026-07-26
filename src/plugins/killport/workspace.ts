import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { fileExists } from '../../core/pkg.ts'

/** script 中的 pnpm 目录指示：-C/--dir 是显式路径，-F/--filter 是包名（需 workspace 映射） */
export type PnpmDirFlag = { kind: 'dir'; path: string } | { kind: 'filter'; name: string }

/**
 * 解析 script 文本里的 pnpm 目录指示。非 pnpm 上下文不穿透——
 * -C/-F 在 tar/make/rsync 等命令里是别的语义，穿透会找错目录。
 */
export function parsePnpmDirFlag(scriptText: string): PnpmDirFlag | null {
  if (!/\bpnpm\b/.test(scriptText)) return null
  const dirMatch = /(?:^|\s)(?:-C|--dir)[ =]"?([^"\s]+)"?/.exec(scriptText)
  if (dirMatch) return { kind: 'dir', path: dirMatch[1] }
  const filterMatch = /(?:^|\s)(?:-F|--filter)[ =]"?([^"\s]+)"?/.exec(scriptText)
  if (filterMatch) return { kind: 'filter', name: filterMatch[1] }
  return null
}

/**
 * 解析 pnpm-workspace.yaml 的 packages 列表。
 * 手写行扫描而非引 yaml 依赖：该文件事实上的形态就是 `packages:` + 减号列表，
 * 为一个键引一个解析库不值。
 */
export function parseWorkspaceGlobs(yamlText: string): string[] {
  const globs: string[] = []
  let inPackages = false
  for (const line of yamlText.split('\n')) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    const item = /^\s+-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line)
    if (item) {
      globs.push(item[1].trim())
      continue
    }
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    break
  }
  return globs
}

/**
 * 把 script 实际执行的目录解析出来：-C/--dir 直接相对 baseDir 解析，
 * -F/--filter 经 workspace 包名映射；解析不到返回 baseDir 本身。
 */
export async function resolveScriptDir(scriptText: string, baseDir: string): Promise<string> {
  const flag = parsePnpmDirFlag(scriptText)
  if (flag === null) return baseDir
  if (flag.kind === 'dir') return resolve(baseDir, flag.path)
  return (await resolveWorkspacePackageDir(baseDir, flag.name)) ?? baseDir
}

/**
 * 按 workspace glob 找包名对应的子包目录。
 * 只展开单层 `*` 与无通配目录；`**` 递归 glob 在 packages 声明里罕见，不展开（宁缺不滥）。
 */
export async function resolveWorkspacePackageDir(
  rootDir: string,
  name: string,
): Promise<string | null> {
  const yamlPath = join(rootDir, 'pnpm-workspace.yaml')
  if (!(await fileExists(yamlPath))) return null
  const globs = parseWorkspaceGlobs(await readFile(yamlPath, 'utf8'))
  for (const glob of globs) {
    if (glob.includes('**')) continue
    if (glob.endsWith('/*')) {
      const parent = join(rootDir, glob.slice(0, -2))
      let entries
      try {
        entries = await readdir(parent, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const dir = join(parent, entry.name)
        if ((await readPackageName(dir)) === name) return dir
      }
    } else if (!glob.includes('*')) {
      const dir = join(rootDir, glob)
      if ((await readPackageName(dir)) === name) return dir
    }
  }
  return null
}

async function readPackageName(dir: string): Promise<string | null> {
  try {
    const pkg: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    if (pkg !== null && typeof pkg === 'object' && 'name' in pkg && typeof pkg.name === 'string') {
      return pkg.name
    }
    return null
  } catch {
    return null
  }
}
