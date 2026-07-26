import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractPortFromConfig, loadFrameworkConfig } from '../src/plugins/killport/config.ts'

describe('extractPortFromConfig', () => {
  it.each([
    {
      name: 'vite server.port plain',
      code: 'export default { server: { port: 5174 } }',
      kind: 'vite' as const,
      expected: 5174,
    },
    {
      name: 'defineConfig wrapped',
      code: "import { defineConfig } from 'vite'\nexport default defineConfig({ server: { port: 5174 } })",
      kind: 'vite' as const,
      expected: 5174,
    },
    {
      name: 'nuxt devServer.port',
      code: 'export default defineNuxtConfig({ devServer: { port: 3001 } })',
      kind: 'nuxt' as const,
      expected: 3001,
    },
    {
      // nuxt 的 vite 是 middleware 模式，vite.server.port 不决定监听端口——提取它会清错端口
      name: 'nuxt ignores vite server.port',
      code: 'export default defineNuxtConfig({ vite: { server: { port: 5174 } } })',
      kind: 'nuxt' as const,
      expected: null,
    },
    {
      name: 'nuxt devServer wins when both present',
      code: 'export default defineNuxtConfig({ devServer: { port: 3001 }, vite: { server: { port: 5174 } } })',
      kind: 'nuxt' as const,
      expected: 3001,
    },
    {
      name: 'hmr nested port ignored',
      code: 'export default { server: { hmr: { port: 3002 } } }',
      kind: 'vite' as const,
      expected: null,
    },
    {
      name: 'direct port beats nested hmr',
      code: 'export default { server: { port: 5174, hmr: { port: 3002 } } }',
      kind: 'vite' as const,
      expected: 5174,
    },
    {
      // 变量引用静态提取不到值——跳过（宁缺不滥）
      name: 'variable reference skipped',
      code: 'const p = 5174\nexport default { server: { port: p } }',
      kind: 'vite' as const,
      expected: null,
    },
    {
      name: 'expression skipped',
      code: 'export default { server: { port: Number(5174) } }',
      kind: 'vite' as const,
      expected: null,
    },
    {
      name: 'line comment stripped',
      code: 'export default { server: {\n  // port: 9999\n  port: 5174\n} }',
      kind: 'vite' as const,
      expected: 5174,
    },
    {
      name: 'block comment stripped',
      code: 'export default { /* server: { port: 9999 } */ server: { port: 5174 } }',
      kind: 'vite' as const,
      expected: 5174,
    },
    {
      name: 'string with braces does not break depth',
      code: "export default { server: { path: '/{id}', port: 5174 } }",
      kind: 'vite' as const,
      expected: 5174,
    },
    {
      name: 'string with comment-like content',
      code: "export default { base: 'http://a.com', server: { port: 5174 } }",
      kind: 'vite' as const,
      expected: 5174,
    },
    {
      name: 'quoted key',
      code: "export default { 'server': { port: 5174 } }",
      kind: 'vite' as const,
      expected: 5174,
    },
    {
      name: 'no server key',
      code: 'export default { plugins: [] }',
      kind: 'vite' as const,
      expected: null,
    },
    {
      name: 'out of range port',
      code: 'export default { server: { port: 99999 } }',
      kind: 'vite' as const,
      expected: null,
    },
  ])('$name', ({ code, kind, expected }) => {
    expect(extractPortFromConfig(code, kind)).toBe(expected)
  })
})

describe('loadFrameworkConfig', () => {
  it('finds vite.config.ts with kind vite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dv-cfg-'))
    try {
      await writeFile(join(dir, 'vite.config.ts'), 'export default {}')
      expect(await loadFrameworkConfig(dir)).toMatchObject({ path: join(dir, 'vite.config.ts'), kind: 'vite' })
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  it('prefers nuxt.config over vite.config when both exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dv-cfg-'))
    try {
      await writeFile(join(dir, 'nuxt.config.ts'), 'export default {}')
      await writeFile(join(dir, 'vite.config.ts'), 'export default {}')
      // nuxt 项目两 config 并存时，devServer.port 才是对外监听端口
      expect(await loadFrameworkConfig(dir)).toMatchObject({ path: join(dir, 'nuxt.config.ts'), kind: 'nuxt' })
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  it('returns null when no framework config exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dv-cfg-'))
    try {
      expect(await loadFrameworkConfig(dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})
