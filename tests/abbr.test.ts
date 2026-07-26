import { describe, expect, it } from 'vitest'

import { buildAbbreviationMap, resolveCommand } from '../src/core/index.ts'

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
