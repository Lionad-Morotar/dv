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
  | { kind: 'fuzzy'; name: string }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'none' }

/**
 * query 的字符是否按序（不必连续）出现在 name 中——fzf 式子序列匹配。
 * 两侧统一小写：脚本名恒为小写 kebab，而用户凭记忆敲入的把手可能带大写，
 * 作为解析链的末位兜底，宽松一点比苛责更省记忆。空串视为命中任意。
 */
export function isSubsequence(query: string, name: string): boolean {
  const q = query.toLowerCase()
  const haystack = name.toLowerCase()
  let i = 0
  for (const ch of haystack) {
    if (ch === q[i]) i++
  }
  return i === q.length
}

/** 词边界分隔符：kebab 脚本名里段与段的分界，命中其后的字符视为词首命中 */
const BOUNDARY_CHARS = new Set(['-', ':', '_', '.', '/'])
const BOUNDARY_BONUS = 2
const CONTIGUOUS_BONUS = 1

/**
 * fzf 式子序列评分：query 是 name 的子序列则返回分数，否则 null。
 * 最左贪婪定位后按两类信号加分——词首命中（分隔符之后，+2）与连续命中（相邻，+1）。
 * 词首加分让首字母式把手 dplr 在 pure-line-room-tour（四字符全词首）压过 ply-particles（中段命中），
 * 而完全同形的公共片段（如两个 shine-cards*）得分相同、保留歧义。评分只用于择优，
 * 并列最高分仍报歧义——绝不因细微分差静默猜错。最左贪婪对边界命中偏保守，
 * 至多低估而不会高估错选，与"宁报错不猜错"同向。
 */
export function scoreSubsequence(query: string, name: string): number | null {
  const q = query.toLowerCase()
  const haystack = name.toLowerCase()
  const positions: number[] = []
  let i = 0
  for (let j = 0; j < haystack.length && i < q.length; j++) {
    if (haystack[j] === q[i]) {
      positions.push(j)
      i++
    }
  }
  if (i < q.length) return null

  let score = 0
  for (let k = 0; k < positions.length; k++) {
    const p = positions[k]
    if (p === 0 || BOUNDARY_CHARS.has(haystack[p - 1])) score += BOUNDARY_BONUS
    if (k > 0 && p === positions[k - 1] + 1) score += CONTIGUOUS_BONUS
  }
  return score
}

/**
 * 解析链（决策 D8）：全名精确 > 缩写精确 > 全名前缀唯一 > 模糊子序列择优 > 歧义 > 无匹配。
 * 模糊阶段兜底吃下用户凭名字记忆的把手（room / dpure / 首字母缩写），
 * 命中多个时按 scoreSubsequence 择唯一最高分；最高分并列则与前缀阶段一样报歧义而非猜测——
 * 静默选中错误 script 比报错更糟。
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

  const names = Object.keys(scripts)
  const prefixMatches = names.filter((name) => name.startsWith(input))
  if (prefixMatches.length === 1) {
    return { kind: 'prefix', name: prefixMatches[0] }
  }
  if (prefixMatches.length > 1) {
    return { kind: 'ambiguous', matches: prefixMatches }
  }

  const scored = names
    .map((name) => ({ name, score: scoreSubsequence(input, name) }))
    .filter((entry): entry is { name: string; score: number } => entry.score !== null)
  if (scored.length === 1) {
    return { kind: 'fuzzy', name: scored[0].name }
  }
  if (scored.length > 1) {
    const best = Math.max(...scored.map((entry) => entry.score))
    const top = scored.filter((entry) => entry.score === best).map((entry) => entry.name)
    if (top.length === 1) {
      return { kind: 'fuzzy', name: top[0] }
    }
    return { kind: 'ambiguous', matches: top }
  }

  return { kind: 'none' }
}
