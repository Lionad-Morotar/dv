import { describe, expect, it } from 'vitest'
import { createHooks } from 'hookable'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { pluginsCommand } from '../src/commands/plugins.ts'
import { killportPlugin, registerPlugins } from '../src/plugins/registry.ts'
import { readConfig } from '../src/plugins/state.ts'
import type { DvHooks } from '../src/core/hooks.ts'
import type { DvPlugin } from '../src/plugins/types.ts'

class CaptureStream extends Writable {
  text = ''
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.text += chunk.toString()
    cb()
  }
}

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dv-plugins-'))
  return join(dir, 'config.json')
}

describe('dv plugins', () => {
  it('lists builtin plugins with their state', async () => {
    const out = new CaptureStream()
    const code = await pluginsCommand('list', undefined, {
      configPath: await tempConfigPath(),
      stdout: out,
      stderr: out,
    })
    expect(code).toBe(0)
    expect(out.text).toContain('kp')
    expect(out.text).toContain('enabled')
  })

  it('disables a plugin and persists it across reads', async () => {
    const configPath = await tempConfigPath()
    const out = new CaptureStream()
    expect(await pluginsCommand('disable', 'kp', { configPath, stdout: out, stderr: out })).toBe(0)
    expect(await pluginsCommand('list', undefined, { configPath, stdout: out, stderr: out })).toBe(0)
    expect(out.text).toContain('kp  disabled')
  })

  it('re-enables a disabled plugin', async () => {
    const configPath = await tempConfigPath()
    const out = new CaptureStream()
    await pluginsCommand('disable', 'kp', { configPath, stdout: out, stderr: out })
    await pluginsCommand('enable', 'kp', { configPath, stdout: out, stderr: out })
    await pluginsCommand('list', undefined, { configPath, stdout: out, stderr: out })
    expect(out.text).toContain('kp  enabled')
  })

  it('rejects an unknown plugin name and lists known ones', async () => {
    const out = new CaptureStream()
    const code = await pluginsCommand('disable', 'foo', {
      configPath: await tempConfigPath(),
      stdout: out,
      stderr: out,
    })
    expect(code).toBe(1)
    expect(out.text).toContain('unknown plugin "foo"')
    expect(out.text).toContain('kp')
  })

  it('falls back to all-enabled when the config file is corrupted', async () => {
    const configPath = await tempConfigPath()
    await writeFile(configPath, '{ not json', 'utf8')
    const config = await readConfig(configPath)
    expect(config.plugins).toEqual({})
    const out = new CaptureStream()
    await pluginsCommand('list', undefined, { configPath, stdout: out, stderr: out })
    expect(out.text).toContain('enabled')
  })
})

describe('registerPlugins', () => {
  it('mounts only enabled plugins; a disabled plugin leaves no hook trace', async () => {
    const configPath = await tempConfigPath()
    const out = new CaptureStream()
    await pluginsCommand('disable', 'spy', {
      configPath,
      plugins: [killportPlugin, spyPlugin],
      stdout: out,
      stderr: out,
    })

    let setups = 0
    spyPlugin.setup = () => {
      setups++
    }
    const hooks = createHooks<DvHooks>()
    const mounted = await registerPlugins(hooks, [killportPlugin, spyPlugin], configPath)

    expect(setups).toBe(0)
    expect(mounted).toEqual(['kp'])
  })
})

const spyPlugin: DvPlugin = {
  name: 'spy',
  description: 'test spy',
  setup: () => {},
}
