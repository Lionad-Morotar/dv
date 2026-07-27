import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import {
  parsePnpmDirFlag,
  parsePnpmScriptName,
  parseWorkspaceGlobs,
  resolveDelegatedScriptText,
  resolveScriptDir,
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

describe('parsePnpmScriptName', () => {
  it.each([
    // 基本：吞值 flag 与其值、run 关键字都被跳过，首个实参为 script 名
    { script: 'pnpm --filter web dev', expected: 'dev' },
    { script: 'pnpm -C packages/web dev', expected: 'dev' },
    { script: 'pnpm --dir packages/web dev', expected: 'dev' },
    { script: 'pnpm -F @test/web dev', expected: 'dev' },
    { script: 'pnpm --filter web run dev', expected: 'dev' },
    { script: 'pnpm --filter web run-script dev', expected: 'dev' },
    // = 形式是单 token，不吞下一个 token
    { script: 'pnpm --filter=@test/web dev', expected: 'dev' },
    { script: 'pnpm --dir=packages/web dev', expected: 'dev' },
    // 引号包裹的 filter 值整体作为值跳过
    { script: 'pnpm --filter "@test/web" dev', expected: 'dev' },
    // 布尔 flag 不吞值；前缀 env 赋值不影响 pnpm 定位
    { script: 'pnpm --silent --filter web dev', expected: 'dev' },
    { script: 'PORT=1 pnpm -F web dev', expected: 'dev' },
    // 无 flag 的同包委托与 script 名后的附加参数
    { script: 'pnpm dev:web', expected: 'dev:web' },
    { script: 'pnpm "dev:web"', expected: 'dev:web' },
    { script: 'pnpm --filter web dev -- --open', expected: 'dev' },
    // 宁缺勿滥：无 script 名或非 pnpm 命令
    { script: 'pnpm --filter web', expected: null },
    { script: 'pnpm --filter web run', expected: null },
    { script: 'pnpm --filter web -- dev', expected: null },
    { script: 'npm run dev', expected: null },
    { script: 'vite --port 3000', expected: null },
    // \bpnpm\b 匹配连字符连接词（foo-pnpm）时无独立 pnpm token，仍应判非委托
    { script: 'foo-pnpm dev', expected: null },
  ])('$script', ({ script, expected }) => {
    expect(parsePnpmScriptName(script)).toBe(expected)
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

describe('resolveScriptDir', () => {
  it('resolves the workspace package directory via --filter', async () => {
    expect(await resolveScriptDir('pnpm --filter @test/web dev', monorepo)).toBe(`${monorepo}/packages/web`)
  })

  it('resolves via -C directory flag', async () => {
    expect(await resolveScriptDir('pnpm -C packages/web dev', monorepo)).toBe(`${monorepo}/packages/web`)
  })

  it('returns baseDir for flag-less commands (same-package context)', async () => {
    expect(await resolveScriptDir('pnpm dev', monorepo)).toBe(monorepo)
    expect(await resolveScriptDir('vite dev', basic)).toBe(basic)
  })

  // --filter 无匹配 = 委托失败：返回 null 而非回落 baseDir。
  // 回落会让 config 与 script 搜索命中根包——与失败委托无关的实体，
  // 从中提取端口会错杀（kp 核心不变式）
  it('returns null when --filter matches no workspace package', async () => {
    expect(await resolveScriptDir('pnpm --filter @test/ghost dev', monorepo)).toBeNull()
  })
})

describe('resolveDelegatedScriptText', () => {
  const webDir = `${monorepo}/packages/web`

  it('reads the delegated script text from the resolved directory', async () => {
    expect(await resolveDelegatedScriptText('pnpm --filter @test/web dev', webDir)).toContain('WEB_RAN')
  })

  it('treats a flag-less pnpm call as same-package delegation', async () => {
    expect(await resolveDelegatedScriptText('pnpm dev', monorepo)).toBe('echo ROOT_DEV')
  })

  it('returns null when the target package has no such script', async () => {
    expect(await resolveDelegatedScriptText('pnpm --filter @test/web build', webDir)).toBeNull()
  })

  it('returns null for non-pnpm commands', async () => {
    expect(await resolveDelegatedScriptText('vite --port 3000', webDir)).toBeNull()
  })
})
