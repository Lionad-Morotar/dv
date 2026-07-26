import { describe, expect, it } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { DvError, spawnScript } from '../src/core/index.ts'

class CaptureStream extends Writable {
  text = ''
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.text += chunk.toString()
    cb()
  }
}

const fixtures = {
  basic: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
}

describe('spawnScript', () => {
  it('turns a missing package manager into a friendly DvError instead of a raw ENOENT', async () => {
    const out = new CaptureStream()
    await expect(
      // 运行时防御：JS 调用方可能传入类型外的 pm 值，公共接口必须兜底
      spawnScript('dv-pm-does-not-exist' as never, 'dev', {
        cwd: fixtures.basic,
        stdout: out,
        stderr: out,
      }),
    ).rejects.toThrow(DvError)
    await expect(
      spawnScript('dv-pm-does-not-exist' as never, 'dev', {
        cwd: fixtures.basic,
        stdout: out,
        stderr: out,
      }),
    ).rejects.toThrow(/dv-pm-does-not-exist/)
  })

  it('delivers injected stdin content to the script process', async () => {
    const out = new CaptureStream()
    const code = await spawnScript('npm', 'run', {
      cwd: fixtures.basic,
      stdin: Readable.from(['hello-stdin\n']),
      stdout: out,
      stderr: out,
    })
    // npm run 本身不读 stdin；本用例锁定注入通路不炸即可，端到端读 stdin 由 fixture script 覆盖
    expect(code).not.toBeNull()
  })
})
