import { describe, expect, it } from 'vitest'

import { buildAbbreviationMap, isSubsequence, resolveCommand, scoreSubsequence } from '../src/core/index.ts'

/** 辅助：从 Map 反转出 scriptName -> abbr 便于断言 */
function abbrOf(map: Map<string, string>, scriptName: string): string | undefined {
  for (const [abbr, name] of map) {
    if (name === scriptName) return abbr
  }
  return undefined
}

describe('buildAbbreviationMap', () => {
  it.each([
    { scripts: ['dev:website'], expected: { 'dev:website': 'dw' } },
    { scripts: ['dev'], expected: { dev: 'd' } },
    { scripts: ['build'], expected: { build: 'b' } },
    { scripts: ['dev:web:foo'], expected: { 'dev:web:foo': 'dwf' } },
  ])('generates segment-initial abbreviations: $scripts', ({ scripts, expected }) => {
    const map = buildAbbreviationMap(scripts)
    for (const [name, abbr] of Object.entries(expected)) {
      expect(abbrOf(map, name)).toBe(abbr)
    }
  })

  it('gives the earlier-declared script the shortest abbreviation on conflict', () => {
    const map = buildAbbreviationMap(['dev:web', 'dev:website'])
    expect(abbrOf(map, 'dev:web')).toBe('dw')
    expect(abbrOf(map, 'dev:website')).toBe('dwe')
  })

  it('is order-sensitive: reversing declaration order swaps the abbreviations', () => {
    const map = buildAbbreviationMap(['dev:website', 'dev:web'])
    expect(abbrOf(map, 'dev:website')).toBe('dw')
    expect(abbrOf(map, 'dev:web')).toBe('dwe')
  })

  it('extends the conflicting segment until unique across three collisions', () => {
    const map = buildAbbreviationMap(['dev:web', 'dev:website', 'dev:webapp'])
    expect(abbrOf(map, 'dev:web')).toBe('dw')
    expect(abbrOf(map, 'dev:website')).toBe('dwe')
    expect(abbrOf(map, 'dev:webapp')).toBe('dweb')
  })

  it('extends single-segment names the same way', () => {
    const map = buildAbbreviationMap(['dev', 'docs'])
    expect(abbrOf(map, 'dev')).toBe('d')
    expect(abbrOf(map, 'docs')).toBe('do')
  })

  it('extends the last segment first in multi-segment collisions', () => {
    const map = buildAbbreviationMap(['dev:web:foo', 'dev:web:faq'])
    expect(abbrOf(map, 'dev:web:foo')).toBe('dwf')
    expect(abbrOf(map, 'dev:web:faq')).toBe('dwfa')
  })
})

describe('resolveCommand', () => {
  const scripts = {
    dev: 'echo dev',
    'dev:web': 'echo web',
    'dev:website': 'echo website',
  }

  it('prefers the exact full name over abbreviation and prefix', () => {
    // dev 既是全名，也是 dev:web/dev:website 的前缀、还是自身缩写 d 的持有者
    expect(resolveCommand('dev', scripts)).toEqual({ kind: 'exact', name: 'dev' })
    expect(resolveCommand('dev:website', scripts)).toEqual({ kind: 'exact', name: 'dev:website' })
  })

  it('resolves an exact abbreviation', () => {
    expect(resolveCommand('dw', scripts)).toEqual({ kind: 'abbr', name: 'dev:web' })
    expect(resolveCommand('dwe', scripts)).toEqual({ kind: 'abbr', name: 'dev:website' })
  })

  it('resolves a unique full-name prefix', () => {
    expect(resolveCommand('dev:websi', scripts)).toEqual({ kind: 'prefix', name: 'dev:website' })
  })

  it('reports an ambiguous prefix with its matches', () => {
    const result = resolveCommand('dev:w', scripts)
    expect(result.kind).toBe('ambiguous')
    expect((result as { matches: string[] }).matches).toEqual(['dev:web', 'dev:website'])
  })

  it('reports no match', () => {
    expect(resolveCommand('zzz', scripts).kind).toBe('none')
  })
})

describe('isSubsequence', () => {
  it('matches characters appearing in order', () => {
    expect(isSubsequence('plr', 'pure-line-room')).toBe(true)
    expect(isSubsequence('room', 'pure-line-room')).toBe(true)
  })

  it('is order-sensitive: same chars in wrong order do not match', () => {
    // room 含 r 与 m，但 m 在 r 之后；mr 要求 m 后再出现 r，不成立
    expect(isSubsequence('rm', 'room')).toBe(true)
    expect(isSubsequence('mr', 'room')).toBe(false)
  })

  it('is case-insensitive on both sides', () => {
    expect(isSubsequence('ROOM', 'pure-line-room')).toBe(true)
    expect(isSubsequence('room', 'PURE-LINE-ROOM')).toBe(true)
  })

  it('empty query matches anything; longer query never matches', () => {
    expect(isSubsequence('', 'abc')).toBe(true)
    expect(isSubsequence('abcd', 'abc')).toBe(false)
  })
})

describe('scoreSubsequence', () => {
  it('returns null when the query is not an ordered subsequence', () => {
    expect(scoreSubsequence('xyz', 'pure-line')).toBeNull()
    // room 含 r 与 m 但顺序是 r…m；mr 要求 m 后有 r，不成序
    expect(scoreSubsequence('mr', 'room')).toBeNull()
  })

  it('returns 0 for an empty query (a trivial match)', () => {
    expect(scoreSubsequence('', 'abc')).toBe(0)
  })

  it('awards a boundary bonus for a char right after a separator', () => {
    // p 在 a-p 里位于 - 之后(词首, +2)；在 ap 里位于字母之后(无加分)
    expect(scoreSubsequence('p', 'a-p')).toBe(2)
    expect(scoreSubsequence('p', 'ap')).toBe(0)
    // 名字起始也算词首
    expect(scoreSubsequence('p', 'pure')).toBe(2)
  })

  it('awards a contiguous bonus for consecutive matched chars', () => {
    // dev:web 上的 web：w 词首(+2)，e、b 连续(各 +1) = 4
    expect(scoreSubsequence('web', 'dev:web')).toBe(4)
  })

  it('lets word-boundary hits outrank mid-word hits on the same query', () => {
    // dplr 在 pure-line-room-tour 四字符全词首(4×2=8)，
    // 在 ply-particles 仅 d、p 词首、l 连续、r 中段(2+2+1+0=5)
    const pure = scoreSubsequence('dplr', 'dev:260728-pure-line-room-tour')
    const ply = scoreSubsequence('dplr', 'dev:260723-ply-particles')
    expect(pure).toBe(8)
    expect(ply).toBe(5)
    expect(pure!).toBeGreaterThan(ply!)
  })

  it('is case-insensitive', () => {
    expect(scoreSubsequence('DPLR', 'dev:260728-pure-line-room-tour')).toBe(8)
  })
})

describe('resolveCommand fuzzy subsequence stage', () => {
  // 取名镜像真实 Demo monorepo：日期前缀脚本名，名字部分才是用户记得住的把手
  const demoScripts = {
    'dev:260728-pure-line-room-tour': 'echo pure',
    'dev:260727-crystal-shader-tour': 'echo crystal',
    'dev:260723-ply-particles': 'echo ply',
  }

  it('resolves a memorable handle that is a unique subsequence', () => {
    expect(resolveCommand('room', demoScripts)).toEqual({
      kind: 'fuzzy',
      name: 'dev:260728-pure-line-room-tour',
    })
    expect(resolveCommand('crystal', demoScripts)).toEqual({
      kind: 'fuzzy',
      name: 'dev:260727-crystal-shader-tour',
    })
  })

  it('resolves a unique initialism (dplr + pure 的字符全序命中且仅 pure 含 u)', () => {
    expect(resolveCommand('dpure', demoScripts)).toEqual({
      kind: 'fuzzy',
      name: 'dev:260728-pure-line-room-tour',
    })
  })

  it('resolves an initialism to the higher word-boundary score (dplr -> pure-line)', () => {
    // d-p-l-r 同是 pure-line 与 ply 的子序列，但 pure-line 四字符全词首、得分更高 → 唯一最高执行
    expect(resolveCommand('dplr', demoScripts)).toEqual({
      kind: 'fuzzy',
      name: 'dev:260728-pure-line-room-tour',
    })
  })

  it('prefers the cleaner boundary hit when scores differ (tour -> pure-line)', () => {
    // tour 在 pure-line 里整段 -tour 词首连续(高分)；在 crystal-shader-tour 里
    // 最左贪婪先撞上 crystal 中段的 t(非词首、低分) → 唯一最高分执行 pure-line
    expect(resolveCommand('tour', demoScripts)).toEqual({
      kind: 'fuzzy',
      name: 'dev:260728-pure-line-room-tour',
    })
  })

  it('still reports ambiguity when the best scores tie on an identical token', () => {
    // shine 在两名里都是 -shine 词首连续片段，得分完全相同 → 并列报歧义而非猜
    const shineScripts = {
      'dev:260616-shine-cards': 'echo cards',
      'dev:260610-shine-cards-kimi': 'echo kimi',
    }
    const result = resolveCommand('shine', shineScripts)
    expect(result.kind).toBe('ambiguous')
    expect((result as { matches: string[] }).matches).toEqual([
      'dev:260616-shine-cards',
      'dev:260610-shine-cards-kimi',
    ])
  })

  it('matches case-insensitively at the fuzzy stage', () => {
    expect(resolveCommand('ROOM', demoScripts)).toEqual({
      kind: 'fuzzy',
      name: 'dev:260728-pure-line-room-tour',
    })
  })

  it('keeps earlier stages ahead of fuzzy: exact full name still wins', () => {
    expect(resolveCommand('dev:260723-ply-particles', demoScripts)).toEqual({
      kind: 'exact',
      name: 'dev:260723-ply-particles',
    })
  })

  it('keeps earlier stages ahead of fuzzy: a unique prefix resolves as prefix, not fuzzy', () => {
    // dev:260728 作为子序列也唯一命中 pure，但前缀阶段在先，kind 必须是 prefix
    expect(resolveCommand('dev:260728', demoScripts)).toEqual({
      kind: 'prefix',
      name: 'dev:260728-pure-line-room-tour',
    })
  })

  it('reports none when no script contains the query as a subsequence', () => {
    expect(resolveCommand('q', demoScripts).kind).toBe('none')
    expect(resolveCommand('zzz', demoScripts).kind).toBe('none')
  })
})
