import { resolve } from 'node:path'

import { fileExists } from './pkg.ts'

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

/** lock 文件到包管理器的映射，数组顺序即检测优先级 */
const LOCK_TABLE: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
]

/**
 * 按 lock 文件检测包管理器；无 lock 时默认 pnpm（工具作者的主环境）。
 * 只探测目标目录本身，不向上查找——--path 语义应精确。
 */
export async function detectPackageManager(dir: string): Promise<PackageManager> {
  for (const [lockfile, pm] of LOCK_TABLE) {
    if (await fileExists(resolve(dir, lockfile))) {
      return pm
    }
  }
  return 'pnpm'
}
