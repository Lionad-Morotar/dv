import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectPackageManager } from '../src/core/index.ts'

async function dirWith(lockfiles: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dv-pm-'))
  for (const file of lockfiles) {
    await writeFile(join(dir, file), '', 'utf8')
  }
  return dir
}

describe('detectPackageManager', () => {
  it.each([
    { lockfiles: [], expected: 'pnpm' },
    { lockfiles: ['pnpm-lock.yaml'], expected: 'pnpm' },
    { lockfiles: ['package-lock.json'], expected: 'npm' },
    { lockfiles: ['yarn.lock'], expected: 'yarn' },
    { lockfiles: ['bun.lock'], expected: 'bun' },
    { lockfiles: ['bun.lockb'], expected: 'bun' },
    { lockfiles: ['pnpm-lock.yaml', 'package-lock.json'], expected: 'pnpm' },
  ])('$lockfiles -> $expected', async ({ lockfiles, expected }) => {
    expect(await detectPackageManager(await dirWith(lockfiles))).toBe(expected)
  })
})
