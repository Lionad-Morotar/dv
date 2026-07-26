/**
 * 最简前缀匹配核心：缩写生成、冲突消解、命令解析链。
 * 全部为纯函数，不触 fs/进程——表驱动单测的最大收益区。
 */

/**
 * 为 scripts（按声明顺序）生成 缩写 -> script 名 的映射。
 * 初始缩写 = 按 `:` 分段后各段首字母拼接；冲突时先声明者占最短，
 * 后声明者从最后一段起逐字符加长该段前缀，直到全局唯一（决策 D2）。
 */
export function buildAbbreviationMap(scriptNames: string[]): Map<string, string> {
  const taken = new Set<string>()
  const map = new Map<string, string>()

  for (const name of scriptNames) {
    const segments = name.split(':')
    const lens = segments.map(() => 1)

    const abbr = () => segments.map((seg, i) => seg.slice(0, lens[i])).join('')

    while (taken.has(abbr())) {
      // 从后往前找第一个未达全长的段扩展；全满只可能是同名，scripts key 唯一，防御性跳出
      let i = lens.length - 1
      while (i >= 0 && lens[i] >= segments[i].length) {
        i--
      }
      if (i < 0) break
      lens[i]++
    }

    const resolved = abbr()
    taken.add(resolved)
    map.set(resolved, name)
  }

  return map
}

export type ResolveResult =
  | { kind: 'exact'; name: string }
  | { kind: 'abbr'; name: string }
  | { kind: 'prefix'; name: string }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'none' }

/**
 * 解析链（决策 D8）：全名精确 > 缩写精确 > 全名前缀唯一 > 歧义 > 无匹配。
 * 前缀歧义不猜测执行——歧义时静默选中错误 script 比报错更糟。
 */
export function resolveCommand(input: string, scripts: Record<string, string>): ResolveResult {
  if (input in scripts) {
    return { kind: 'exact', name: input }
  }

  const abbrMap = buildAbbreviationMap(Object.keys(scripts))
  const byAbbr = abbrMap.get(input)
  if (byAbbr !== undefined) {
    return { kind: 'abbr', name: byAbbr }
  }

  const prefixMatches = Object.keys(scripts).filter((name) => name.startsWith(input))
  if (prefixMatches.length === 1) {
    return { kind: 'prefix', name: prefixMatches[0] }
  }
  if (prefixMatches.length > 1) {
    return { kind: 'ambiguous', matches: prefixMatches }
  }

  return { kind: 'none' }
}
