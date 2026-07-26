import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import {
  parsePnpmDirFlag,
  parseWorkspaceGlobs,
  resolveWorkspacePackageDir,
} from '../src/plugins/killport/workspace.ts'

const monorepo = fileURLToPath(new URL('./fixtures/monorepo', import.meta.url))
const basic = fileURLToPath(new URL('./fixtures/basic', import.meta.url))

describe('parsePnpmDirFlag', () => {
  it.each([
    { script: 'pnpm -C packages/web dev', expected: { kind: 'dir', path: 'packages/web' } },
    { script: 'pnpm --dir packages/web dev', expected: { kind: 'dir', path: 'packages/web' } },
    { script: 'pnpm --dir=packages/web dev', expected: { kind: 'dir', path: 'packages/web' } },
    { script: 'pnpm --filter @test/web dev', expected: { kind: 'filter', name: '@test/web' } },
    { script: 'pnpm --filter=@test/web dev', expected: { kind: 'filter', name: '@test/web' } },
    { script: 'pnpm -F @test/web dev', expected: { kind: 'filter', name: '@test/web' } },
    { script: 'pnpm --filter "@test/web" dev', expected: { kind: 'filter', name: '@test/web' } },
    { script: 'pnpm dev', expected: null },
    // 非 pnpm 上下文：-C 可能是 tar/make 等命令的其他语义，不做穿透
    { script: 'npm run dev', expected: null },
    { script: 'tar -C /tmp -xf a.tar', expected: null },
    { script: 'vite -C packages/web', expected: null },
  ])('$script', ({ script, expected }) => {
    expect(parsePnpmDirFlag(script)).toEqual(expected)
  })
})

describe('parseWorkspaceGlobs', () => {
  it('parses quoted, plain and unglobbed entries', () => {
    const yaml = `packages:
  - 'packages/*'
  - "apps/*"
  - libs/utils
`
    expect(parseWorkspaceGlobs(yaml)).toEqual(['packages/*', 'apps/*', 'libs/utils'])
  })

  it('stops at the next top-level key', () => {
    const yaml = `packages:
  - 'packages/*'
catalog:
  react: ^19.0.0
`
    expect(parseWorkspaceGlobs(yaml)).toEqual(['packages/*'])
  })

  it('returns empty when no packages key', () => {
    expect(parseWorkspaceGlobs('catalog:\n  react: ^19.0.0\n')).toEqual([])
  })

  it('skips comment lines inside the list', () => {
    const yaml = `packages:
  # workspace packages
  - 'packages/*'
`
    expect(parseWorkspaceGlobs(yaml)).toEqual(['packages/*'])
  })
})

describe('resolveWorkspacePackageDir', () => {
  it('maps a package name to its directory via workspace globs', async () => {
    expect(await resolveWorkspacePackageDir(monorepo, '@test/web')).toBe(`${monorepo}/packages/web`)
  })

  it('returns null for an unknown package name', async () => {
    expect(await resolveWorkspacePackageDir(monorepo, '@test/nope')).toBeNull()
  })

  it('returns null when no pnpm-workspace.yaml exists', async () => {
    // basic fixture 的 pnpm-workspace.yaml 是空 packages 声明，映射不到任何包
    expect(await resolveWorkspacePackageDir(basic, '@test/web')).toBeNull()
  })
})
