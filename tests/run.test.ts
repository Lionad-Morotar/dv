import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { run } from '../src/run.ts'

/** 收集流：测试注入以断言 dv 的输出，替代直接读 process.stdout */
class CaptureStream extends Writable {
  text = ''
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.text += chunk.toString()
    cb()
  }
}

const fixtures = {
  root: fileURLToPath(new URL('./fixtures', import.meta.url)),
  basic: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
}

describe('dv <cmd>', () => {
  it('runs the exact-named script and passes through its exit code', async () => {
    const out = new CaptureStream()
    const code = await run('dev', { path: fixtures.basic, stdout: out, stderr: out })
    expect(code).toBe(0)
    expect(out.text).toContain('DEV_RAN')
  })

  it('passes through a non-zero exit code from the script', async () => {
    const out = new CaptureStream()
    const code = await run('build', { path: fixtures.basic, mode: 'build', stdout: out, stderr: out })
    expect(code).toBe(3)
  })

  it('resolves a relative --path against the given cwd', async () => {
    const out = new CaptureStream()
    const code = await run('dev:web', {
      cwd: fixtures.root,
      path: './basic',
      stdout: out,
      stderr: out,
    })
    expect(code).toBe(0)
    expect(out.text).toContain('WEB_RAN')
  })

  it('falls back to cwd when --path is omitted', async () => {
    const out = new CaptureStream()
    const code = await run('dev', { cwd: fixtures.basic, stdout: out, stderr: out })
    expect(code).toBe(0)
    expect(out.text).toContain('DEV_RAN')
  })

  it('hides dev-scope scripts when --mode build', async () => {
    const out = new CaptureStream()
    const code = await run('dev', { path: fixtures.basic, mode: 'build', stdout: out, stderr: out })
    expect(code).toBe(1)
    expect(out.text).toContain('no script matching "dev" in mode "build"')
  })

  it('rejects an unknown mode value with a clear message', async () => {
    const out = new CaptureStream()
    const code = await run('dev', { path: fixtures.basic, mode: 'foo', stdout: out, stderr: out })
    expect(code).toBe(1)
    expect(out.text).toContain('no scripts in mode "foo"')
  })

  it('lists only scripts of the current mode when nothing matches', async () => {
    const out = new CaptureStream()
    const code = await run('nope', { path: fixtures.basic, stdout: out, stderr: out })
    expect(code).toBe(1)
    expect(out.text).toContain('dev:web')
    expect(out.text).not.toContain('build')
  })

  it('runs the script behind an exact abbreviation (dw -> dev:web)', async () => {
    const out = new CaptureStream()
    const code = await run('dw', { path: fixtures.basic, stdout: out, stderr: out })
    expect(code).toBe(0)
    expect(out.text).toContain('WEB_RAN')
    expect(out.text).not.toContain('WEBSITE_RAN')
  })

  it('runs the script behind the extended abbreviation (dwe -> dev:website)', async () => {
    const out = new CaptureStream()
    const code = await run('dwe', { path: fixtures.basic, stdout: out, stderr: out })
    expect(code).toBe(0)
    expect(out.text).toContain('WEBSITE_RAN')
  })

  it('refuses an ambiguous prefix and lists the candidates', async () => {
    const out = new CaptureStream()
    const code = await run('dev:w', { path: fixtures.basic, stdout: out, stderr: out })
    expect(code).toBe(1)
    expect(out.text).toContain('ambiguous')
    expect(out.text).toContain('dev:web')
    expect(out.text).toContain('dev:website')
  })

  it('runs a script resolved only by fuzzy subsequence (website -> dev:website)', async () => {
    // website 既非全名/缩写，也不是任何 script 的前缀，只能由模糊阶段兜底命中
    const out = new CaptureStream()
    const code = await run('website', { path: fixtures.basic, stdout: out, stderr: out })
    expect(code).toBe(0)
    expect(out.text).toContain('WEBSITE_RAN')
    expect(out.text).not.toContain('WEB_RAN\n')
  })

  it('refuses an ambiguous fuzzy match and lists the candidates', async () => {
    // web 是 dev:web 与 dev:website 的公共子序列——模糊命中多个时报歧义而非猜
    const out = new CaptureStream()
    const code = await run('web', { path: fixtures.basic, stdout: out, stderr: out })
    expect(code).toBe(1)
    expect(out.text).toContain('ambiguous')
    expect(out.text).toContain('dev:web')
    expect(out.text).toContain('dev:website')
  })

  it('annotates candidates with their abbreviations when nothing matches', async () => {
    const out = new CaptureStream()
    await run('zzz', { path: fixtures.basic, stdout: out, stderr: out })
    expect(out.text).toContain('dev:web')
    expect(out.text).toContain('(dw)')
    expect(out.text).toContain('dev:website')
    expect(out.text).toContain('(dwe)')
  })

  it('reports a missing package.json with the attempted path', async () => {
    const out = new CaptureStream()
    const code = await run('dev', { path: fixtures.root, stdout: out, stderr: out })
    expect(code).toBe(1)
    expect(out.text).toMatch(/package\.json not found at .*fixtures.package\.json/)
  })

  it('reports an unparseable package.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dv-bad-json-'))
    await writeFile(join(dir, 'package.json'), '{ broken', 'utf8')
    const out = new CaptureStream()
    const code = await run('dev', { path: dir, stdout: out, stderr: out })
    expect(code).toBe(1)
    expect(out.text).toContain('failed to parse package.json')
  })

  it('reports a package.json without scripts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dv-no-scripts-'))
    await writeFile(join(dir, 'package.json'), '{ "name": "empty" }', 'utf8')
    const out = new CaptureStream()
    const code = await run('dev', { path: dir, stdout: out, stderr: out })
    expect(code).toBe(1)
    expect(out.text).toContain('no scripts found')
  })

  it('reports scripts with a non-string value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dv-bad-script-'))
    await writeFile(join(dir, 'package.json'), '{ "scripts": { "dev": 123 } }', 'utf8')
    const out = new CaptureStream()
    const code = await run('dev', { path: dir, stdout: out, stderr: out })
    expect(code).toBe(1)
    expect(out.text).toContain('scripts."dev" must be a string')
  })
})
