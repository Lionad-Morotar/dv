import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const root = fileURLToPath(new URL('..', import.meta.url))
const basic = fileURLToPath(new URL('./fixtures/basic', import.meta.url))

/**
 * 分发验收（对应需求 P1）：npm install -g 后 dv 命令自动注册可用。
 * 完整链路：build → npm pack → 安装到隔离 prefix（不污染真实全局环境）→ 跑 bin。
 */
describe('npm distribution', () => {
  it('packs and installs globally, exposing a working dv command', async () => {
    await execFileAsync('pnpm', ['build'], { cwd: root })

    const packDir = await mkdtemp(join(tmpdir(), 'dv-pack-'))
    const { stdout: packOut } = await execFileAsync(
      'npm',
      ['pack', '--pack-destination', packDir],
      { cwd: root },
    )
    const tarball = join(packDir, packOut.trim().split('\n').at(-1)!)

    const prefix = await mkdtemp(join(tmpdir(), 'dv-prefix-'))
    await execFileAsync('npm', ['install', '-g', '--prefix', prefix, tarball], {
      timeout: 120000,
    })

    const dv = join(prefix, 'bin', 'dv')
    // cac 的 --version 输出完整 banner：dv/0.1.0 darwin-arm64 node-vX.Y.Z
    const { stdout: version } = await execFileAsync(dv, ['--version'])
    expect(version).toContain('dv/0.1.0')

    const { stdout } = await execFileAsync(dv, ['dev', '--path', basic])
    expect(stdout).toContain('DEV_RAN')
  }, 180000)
})
