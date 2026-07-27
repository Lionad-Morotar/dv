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

/** 已知吞值的 pnpm flag：分离形式（`--filter web`）连同值一起跳过；`=` 形式是单 token 自然跳过 */
const PNPM_VALUE_FLAGS = new Set(['-C', '--dir', '-F', '--filter'])

/** pnpm run 系关键字：显式 run 时 script 名在其后一位 */
const PNPM_RUN_KEYWORDS = new Set(['run', 'run-script'])

/**
 * 从 pnpm 命令文本提取被委托执行的 script 名：pnpm 自身 flag 之后的首个实参。
 * 供委托链端口解析用——`pnpm --filter web dev` 真正执行的是子包的 `dev` script。
 * 非 pnpm 命令或无 script 名（如 `pnpm --filter web`）返回 null（宁缺勿滥）。
 * 未知 flag 一律按布尔处理：若其实际吞值，误认的 script 名会在后续
 * scripts 查找中落空——双门控下不会误判端口。
 */
export function parsePnpmScriptName(scriptText: string): string | null {
  if (!/\bpnpm\b/.test(scriptText)) return null
  // 剥离外层引号（简化 shell 语义，不处理转义）：引号 script 名与带引号的 flag 值都按裸 token 处理
  const tokens = scriptText.trim().split(/\s+/).map((t) => t.replace(/^["']+|["']+$/g, ''))
  // \bpnpm\b 可能命中连字符连接词（foo-pnpm）；无独立 pnpm token 即非委托命令
  const start = tokens.indexOf('pnpm')
  if (start === -1) return null
  for (let i = start + 1; i < tokens.length; i++) {
    const token = tokens[i]
    // `--` 之后是 script 参数而非 script 名；它之前没有 script 名说明命令不委托任何 script
    if (token === '--') return null
    if (token.startsWith('-')) {
      if (PNPM_VALUE_FLAGS.has(token)) i++
      continue
    }
    if (PNPM_RUN_KEYWORDS.has(token)) continue
    return token
  }
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
 * -F/--filter 经 workspace 包名映射；无目录指示时返回 baseDir（同包语境）。
 * --filter 包名无匹配返回 null 而非回落 baseDir——委托失败的命令必然执行失败，
 * 回落会让端口搜索命中根包这个无关实体，错杀其上的进程。
 */
export async function resolveScriptDir(scriptText: string, baseDir: string): Promise<string | null> {
  const flag = parsePnpmDirFlag(scriptText)
  if (flag === null) return baseDir
  if (flag.kind === 'dir') return resolve(baseDir, flag.path)
  return await resolveWorkspacePackageDir(baseDir, flag.name)
}

/**
 * 从已解析的执行目录读取被委托 script 的命令文本：`pnpm --filter web dev`
 * 实际执行的是该目录 package.json 的 scripts.dev，端口可能就声明在那条命令行上
 * （nuxt dev --port 2350）。只穿透一层：返回值交给上层做端口解析，不递归再穿透
 * （嵌套委托极罕见，宁缺勿滥）。script 名不存在或命令非 pnpm 委托返回 null。
 */
export async function resolveDelegatedScriptText(
  scriptText: string,
  dir: string,
): Promise<string | null> {
  const name = parsePnpmScriptName(scriptText)
  if (name === null) return null
  return readPackageScript(dir, name)
}

/** 非抛出的 scripts 查找：包目录缺 package.json、无 scripts、script 不存在或非字符串均返回 null */
async function readPackageScript(dir: string, name: string): Promise<string | null> {
  try {
    const pkg: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    if (pkg === null || typeof pkg !== 'object') return null
    const scripts = (pkg as { scripts?: unknown }).scripts
    if (scripts === null || typeof scripts !== 'object') return null
    const script = (scripts as Record<string, unknown>)[name]
    return typeof script === 'string' ? script : null
  } catch {
    return null
  }
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
