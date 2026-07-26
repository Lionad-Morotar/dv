import { describe, expect, it } from 'vitest'
import { createHooks } from 'hookable'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { run } from '../src/run.ts'
import type { DvHookContext, DvHooks } from '../src/core/hooks.ts'

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

describe('plugin hooks', () => {
  it('fires lifecycle hooks in order with a progressively filled context', async () => {
    const calls: Array<{ hook: string; ctx: Partial<DvHookContext> }> = []
    const hooks = createHooks<DvHooks>()
    const record = (hook: string) => (ctx: DvHookContext) => {
      calls.push({
        hook,
        ctx: { scriptName: ctx.scriptName, scriptText: ctx.scriptText, exitCode: ctx.exitCode },
      })
    }
    hooks.hook('scripts:loaded', record('scripts:loaded'))
    hooks.hook('command:resolved', record('command:resolved'))
    hooks.hook('command:before', record('command:before'))
    hooks.hook('command:after', record('command:after'))

    const out = new CaptureStream()
    const code = await run('dev', { path: fixtures.basic, hooks, stdout: out, stderr: out })

    expect(code).toBe(0)
    expect(calls.map((c) => c.hook)).toEqual([
      'scripts:loaded',
      'command:resolved',
      'command:before',
      'command:after',
    ])
    // 上下文随流程逐段填充：resolved 后才有 script 信息，after 才有 exitCode
    expect(calls[0].ctx.scriptName).toBeUndefined()
    expect(calls[1].ctx.scriptName).toBe('dev')
    expect(calls[1].ctx.scriptText).toContain('DEV_RAN')
    expect(calls[2].ctx.scriptName).toBe('dev')
    expect(calls[3].ctx.exitCode).toBe(0)
  })

  it('does not fire resolved/before/after when the command matches nothing', async () => {
    const calls: string[] = []
    const hooks = createHooks<DvHooks>()
    hooks.hook('scripts:loaded', () => {
      calls.push('scripts:loaded')
    })
    hooks.hook('command:resolved', () => {
      calls.push('command:resolved')
    })
    hooks.hook('command:before', () => {
      calls.push('command:before')
    })
    hooks.hook('command:after', () => {
      calls.push('command:after')
    })

    const out = new CaptureStream()
    await run('nope', { path: fixtures.basic, hooks, stdout: out, stderr: out })

    expect(calls).toEqual(['scripts:loaded'])
  })
})
