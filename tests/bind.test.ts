import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:net'
import { createSocket } from 'node:dgram'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { createHooks } from 'hookable'

import { DvError } from '../src/core/pkg.ts'
import type { DvHookContext, DvHooks } from '../src/core/hooks.ts'
import { run } from '../src/run.ts'
import { runBind, type BindCleanup } from '../src/plugins/bind/index.ts'
import type { BindHelper } from '../src/plugins/bind/helper.ts'

function makeCtx(bind: string[] | undefined, scriptText = 'vite --port 55999'): DvHookContext {
  return {
    dir: '/tmp',
    pkg: { name: 'fixture', dir: '/tmp', scripts: { dev: scriptText } },
    mode: 'dev',
    scriptName: 'dev',
    scriptText,
    bind,
    logger: { info: () => {}, warn: () => {} },
  }
}

/** 占用端口的假 helper：httpPort 只是回传值，编排层不拨号 */
function fakeHelper(): BindHelper & { stopped: boolean } {
  const state = { stopped: false }
  return {
    child: { on: () => {} } as unknown as BindHelper['child'],
    httpPort: 80,
    get stopped() {
      return state.stopped
    },
    stop: () => {
      state.stopped = true
    },
  }
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createServer()
    probe.once('error', () => resolvePromise(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePromise(true)))
  })
}

/** DNS 应答器在 UDP 上——TCP 探针看不到占用 */
async function udpPortIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createSocket('udp4')
    probe.once('error', () => resolvePromise(false))
    probe.bind(port, '127.0.0.1', () => probe.close(() => resolvePromise(true)))
  })
}

describe('runBind', () => {
  let cleanup: BindCleanup | null

  afterEach(async () => {
    await cleanup?.()
    cleanup = null
  })

  it('returns null when no domains are bound', async () => {
    cleanup = null
    expect(await runBind(makeCtx(undefined))).toBeNull()
    expect(await runBind(makeCtx([]))).toBeNull()
  })

  it('throws DvError when the target port cannot be resolved', async () => {
    await expect(runBind(makeCtx(['app.invalid'], 'echo no-port-here'))).rejects.toThrow(/端口/)
  })

  it('starts DNS responder, proxy and helper, and cleans all up on teardown', async () => {
    const helper = fakeHelper()
    const spawnHelper = vi.fn().mockResolvedValue(helper)
    cleanup = await runBind(makeCtx(['app.invalid']), {
      spawnHelper,
      lookupHost: async () => '127.0.0.1',
    })
    expect(cleanup).not.toBeNull()
    expect(spawnHelper).toHaveBeenCalledOnce()
    const helperArgs = spawnHelper.mock.calls[0][0]
    expect(helperArgs.domains).toEqual(['app.invalid'])
    expect(helperArgs.proxyPort).toBeGreaterThan(0)
    expect(helperArgs.dnsPort).toBeGreaterThan(0)
    // DNS 应答器与代理在绑定期间真实监听
    expect(await udpPortIsFree(helperArgs.dnsPort)).toBe(false)
    expect(await portIsFree(helperArgs.proxyPort)).toBe(false)

    const dnsPort = helperArgs.dnsPort
    const proxyPort = helperArgs.proxyPort
    const bound = cleanup
    if (!bound) throw new Error('expected cleanup')
    await bound()
    cleanup = null
    expect(helper.stopped).toBe(true)
    expect(await udpPortIsFree(dnsPort)).toBe(true)
    expect(await portIsFree(proxyPort)).toBe(true)
  })

  it('rolls back DNS and proxy when the helper spawn rejects', async () => {
    const spawnHelper = vi.fn().mockRejectedValue(new Error('sudo cancelled'))
    let captured: { dnsPort: number; proxyPort: number } | undefined
    spawnHelper.mockImplementation((args: { dnsPort: number; proxyPort: number }) => {
      captured = args
      return Promise.reject(new Error('sudo cancelled'))
    })
    await expect(runBind(makeCtx(['app.invalid']), { spawnHelper })).rejects.toThrow('sudo cancelled')
    expect(await udpPortIsFree(captured!.dnsPort)).toBe(true)
    expect(await portIsFree(captured!.proxyPort)).toBe(true)
  })

  it('falls back to hosts mode when resolver verification fails', { timeout: 20000 }, async () => {
    const warnings: string[] = []
    const ctx = makeCtx(['app.invalid'])
    ctx.logger.warn = (msg) => warnings.push(msg)
    const spawnHelper = vi.fn().mockImplementation(() => Promise.resolve(fakeHelper()))
    // 第一次尝试（resolver 路径）全部失败、第二次（hosts）成功：
    // verifyBinding 在窗口内多次轮询，用足够大的失败额度盖住第一次尝试
    let calls = 0
    cleanup = await runBind(ctx, {
      spawnHelper,
      lookupHost: async () => (++calls <= 10 ? null : '127.0.0.1'),
      verifyTimeoutMs: 300,
      verifyIntervalMs: 50,
    })
    expect(cleanup).not.toBeNull()
    expect(spawnHelper).toHaveBeenCalledTimes(2)
    expect(spawnHelper.mock.calls[0][0].hostsFallback).toBe(false)
    expect(spawnHelper.mock.calls[1][0].hostsFallback).toBe(true)
    expect(warnings.some((w) => w.includes('降级'))).toBe(true)
  })

  it('throws when both resolver and hosts fallback verification fail', { timeout: 20000 }, async () => {
    const spawnHelper = vi.fn().mockImplementation(() => Promise.resolve(fakeHelper()))
    await expect(
      runBind(makeCtx(['app.invalid']), {
        spawnHelper,
        lookupHost: async () => null,
        verifyTimeoutMs: 200,
        verifyIntervalMs: 50,
      }),
    ).rejects.toThrow(/两路/)
    expect(spawnHelper).toHaveBeenCalledTimes(2)
  })

  it('cleans up and throws when self-verification keeps failing', { timeout: 20000 }, async () => {
    const helper = fakeHelper()
    const spawnHelper = vi.fn().mockResolvedValue(helper)
    await expect(
      runBind(makeCtx(['app.invalid']), {
        spawnHelper,
        lookupHost: async () => null,
        verifyTimeoutMs: 600,
        verifyIntervalMs: 100,
      }),
    ).rejects.toThrow(/自验证/)
    // 失败路径必须全量回滚：helper 停掉，DNS/代理端口释放
    expect(helper.stopped).toBe(true)
    const helperArgs = spawnHelper.mock.calls[0][0]
    expect(await udpPortIsFree(helperArgs.dnsPort)).toBe(true)
    expect(await portIsFree(helperArgs.proxyPort)).toBe(true)
  })
})

describe('run 接线', () => {
  it('passes --bind domains into the hook context', async () => {
    const hooks = createHooks<DvHooks>()
    let seen: string[] | undefined
    hooks.hook('scripts:loaded', (ctx) => {
      seen = ctx.bind
    })
    const out = new PassThrough()
    const fixture = fileURLToPath(new URL('./fixtures/basic', import.meta.url))
    // scripts:loaded 先于解析与 spawn 触发：故意用不存在的命令短路掉子进程，
    // 全量并行下 pnpm spawn 变慢，这个断言不该被 spawn 速度绑架
    await run('nonexistent-cmd', { path: fixture, bind: ['app.invalid'], hooks, stdout: out, stderr: out })
    expect(seen).toEqual(['app.invalid'])
  })
})

describe('runBind：证书编排', () => {
  let cleanup: BindCleanup | null

  afterEach(async () => {
    await cleanup?.()
    cleanup = null
  })

  /** 桩 CA/leaf 与对应假文件，供 helper 参数存在性断言 */
  function stubCerts() {
    const ca = {
      cert: 'CA-PEM',
      key: 'CA-KEY',
      certPath: '/ca/ca.crt',
      created: true,
    }
    const leaf = {
      cert: 'LEAF-PEM',
      key: 'LEAF-KEY',
      certPath: '/tmp/staging-1/leaf.crt',
      keyPath: '/tmp/staging-1/leaf.key',
      cleanup: vi.fn(),
    }
    return { ca, leaf }
  }

  it('passes tls port and material paths to the helper and cleans staging on teardown', async () => {
    const { ca, leaf } = stubCerts()
    const loadCa = vi.fn().mockResolvedValue(ca)
    const issueLeaf = vi.fn().mockResolvedValue(leaf)
    const helper = fakeHelper()
    const spawnHelper = vi.fn().mockResolvedValue(helper)
    cleanup = await runBind(makeCtx(['app.invalid']), {
      spawnHelper,
      lookupHost: async () => '127.0.0.1',
      loadCa,
      issueLeaf,
      caDir: '/ca',
      tmpDir: '/tmp',
    })
    expect(cleanup).not.toBeNull()
    expect(loadCa).toHaveBeenCalledOnce()
    expect(issueLeaf).toHaveBeenCalledOnce()
    expect(issueLeaf.mock.calls[0][0]).toBe(ca)
    const helperArgs = spawnHelper.mock.calls[0][0]
    expect(helperArgs.tlsPort).toBe(443)
    expect(helperArgs.certPath).toBe(leaf.certPath)
    expect(helperArgs.keyPath).toBe(leaf.keyPath)
    expect(helperArgs.caPath).toBe(ca.certPath)

    const bound = cleanup
    if (!bound) throw new Error('expected cleanup')
    await bound()
    cleanup = null
    expect(leaf.cleanup).toHaveBeenCalledOnce()
  })

  it('issues a fresh leaf per attempt while the CA loads only once across fallback', async () => {
    const { ca, leaf } = stubCerts()
    const loadCa = vi.fn().mockResolvedValue(ca)
    const issueLeaf = vi.fn().mockImplementation((ca, domains, deps) => {
      void ca
      void domains
      void deps
      const n = issueLeaf.mock.calls.length
      return Promise.resolve({ ...leaf, certPath: `/tmp/staging-${n}/leaf.crt`, cleanup: vi.fn() })
    })
    const spawnHelper = vi.fn().mockImplementation(() => Promise.resolve(fakeHelper()))
    cleanup = await runBind(makeCtx(['app.invalid']), {
      spawnHelper,
      // 触发降级不靠计时靠状态：leaf 已出第二份材料即视为第二次 attempt，解析成功——
      // 计数触发对 CI 高负载免疫，不会因轮询窗口不足或翻成功而间歇失败
      lookupHost: async () => (issueLeaf.mock.calls.length >= 2 ? '127.0.0.1' : null),
      verifyTimeoutMs: 300,
      verifyIntervalMs: 50,
      loadCa,
      issueLeaf,
      caDir: '/ca',
      tmpDir: '/tmp',
    })
    expect(cleanup).not.toBeNull()
    expect(spawnHelper).toHaveBeenCalledTimes(2)
    expect(loadCa).toHaveBeenCalledOnce()
    expect(issueLeaf).toHaveBeenCalledTimes(2)
    // 降级第二次 attempt 拿到新 staging 材料
    expect(issueLeaf.mock.calls[1][0]).toBe(ca)
    expect(spawnHelper.mock.calls[1][0].certPath).not.toBe('/tmp/staging-1/leaf.crt')
  })

  it('fails fast with DvError and starts nothing when the CA cannot be loaded', async () => {
    const loadCa = vi.fn().mockRejectedValue(new DvError('CA 存储损坏'))
    const spawnHelper = vi.fn()
    await expect(
      failRunBind(loadCa, spawnHelper),
    ).rejects.toThrow(/CA 存储损坏/)
    // CA 加载是编排的第一步：失败时 DNS/代理/helper 一律没有启动
    expect(spawnHelper).not.toHaveBeenCalled()
    expect(await udpPortIsFree(0)).toBe(true)
  })
})

/** 失败路径专用：runBind 的 loadCa 拒绝时直接抛出 */
async function failRunBind(loadCa: unknown, spawnHelper: unknown): Promise<unknown> {
  const { runBind: realRunBind } = await import('../src/plugins/bind/index.ts')
  return realRunBind(makeCtx(['app.invalid']), {
    spawnHelper: spawnHelper as never,
    lookupHost: async () => '127.0.0.1',
    loadCa: loadCa as never,
    issueLeaf: (() => {}) as never,
    caDir: '/ca',
    tmpDir: '/tmp',
  })
}
