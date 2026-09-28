import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addBypassEntries,
  bypassCoversDomain,
  detectSystemProxy,
  desiredEntries,
  parseScutilProxy,
  readBypassSnapshot,
  removeBypassEntries,
  sweepStaleBypass,
  writeBypassSnapshot,
  type BypassRecord,
  type SysProxyDeps,
} from '../src/plugins/bind/sysproxy.ts'

const SCUTIL_ON = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
  ProxyAutoConfigEnable : 0
}`

const SCUTIL_OFF = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
  ProxyAutoConfigEnable : 0
}`

const SCUTIL_PAC = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigString : file:///etc/proxy.pac
}`

function makeRunner(overrides: {
  services?: string
  bypass?: Record<string, string[]>
  failSetFor?: string[]
  failGetFor?: string[]
}): { run: NonNullable<SysProxyDeps['runCommand']>; sets: string[] } {
  const sets: string[] = []
  const bypass = overrides.bypass ?? {}
  const run: NonNullable<SysProxyDeps['runCommand']> = async (file, args) => {
    if (file === 'networksetup' && args[0] === '-listallnetworkservices') {
      return overrides.services ?? 'An asterisk (*) denotes that a network service is disabled.\nWi-Fi\niPhone USB\n*Thunderbolt Bridge\n'
    }
    if (file === 'networksetup' && args[0] === '-getproxybypassdomains') {
      if (overrides.failGetFor?.includes(args[1] ?? '')) throw new Error('networksetup failed')
      return (bypass[args[1] ?? ''] ?? []).join('\n')
    }
    if (file === 'networksetup' && args[0] === '-setproxybypassdomains') {
      const service = args[1] ?? ''
      if (overrides.failSetFor?.includes(service)) throw new Error('networksetup failed')
      bypass[service] = args.slice(2).filter((entry) => entry !== 'Empty')
      sets.push(`${service}: ${bypass[service].join(',') || '(empty)'}`)
      return ''
    }
    throw new Error(`unexpected command ${file} ${args.join(' ')}`)
  }
  return { run, sets }
}

describe('parseScutilProxy', () => {
  it('解析代理开启态：三开关、例外列表、PAC 关闭', () => {
    const state = parseScutilProxy(SCUTIL_ON)
    expect(state.enabled).toBe(true)
    expect(state.pac).toBe(false)
    expect(state.exceptions).toEqual(['127.0.0.1', '*.local'])
  })

  it('解析代理关闭态与 PAC 开启态', () => {
    expect(parseScutilProxy(SCUTIL_OFF)).toMatchObject({ enabled: false, pac: false, exceptions: [] })
    // 纯 PAC 也算代理在管流量：enabled 必须为真，编排层才会走到 PAC 警告分支而非静默跳过
    expect(parseScutilProxy(SCUTIL_PAC)).toMatchObject({ enabled: true, pac: true })
  })
})

describe('detectSystemProxy', () => {
  it('经 scutil --proxy 聚合读视图', async () => {
    const calls: string[] = []
    const state = await detectSystemProxy({
      runCommand: async (file, args) => {
        calls.push(`${file} ${args.join(' ')}`)
        return SCUTIL_ON
      },
    })
    expect(calls).toEqual(['scutil --proxy'])
    expect(state.enabled).toBe(true)
    expect(state.exceptions).toContain('*.local')
  })
})

describe('bypassCoversDomain', () => {
  it('精确、通配（含多级子域）、大小写、全捕获与无点域匹配', () => {
    const exceptions = ['127.0.0.1', '*.local', '*.86links.dev', '<local>']
    expect(bypassCoversDomain(exceptions, '86links.dev')).toBe(false)
    expect(bypassCoversDomain(exceptions, 'ai.86links.dev')).toBe(true)
    expect(bypassCoversDomain(exceptions, 'app.ai.86links.dev')).toBe(true)
    expect(bypassCoversDomain(['AI.86Links.Dev'], 'ai.86links.dev')).toBe(true)
    expect(bypassCoversDomain(exceptions, 'anything.example.com')).toBe(false)
    expect(bypassCoversDomain(['*'], 'anything.example.com')).toBe(true)
    expect(bypassCoversDomain(['<local>'], 'myhost')).toBe(true)
    expect(bypassCoversDomain(['<local>'], 'myhost.dev')).toBe(false)
  })
})

describe('desiredEntries', () => {
  it('每域产出自身与一级泛子域两条目', () => {
    expect(desiredEntries(['ai.86links.dev'])).toEqual(['ai.86links.dev', '*.ai.86links.dev'])
    expect(desiredEntries(['a.dev', 'b.dev'])).toEqual(['a.dev', '*.a.dev', 'b.dev', '*.b.dev'])
  })
})

describe('addBypassEntries', () => {
  it('逐 enabled 服务 merge 注入，disabled 服务不动，追加项逐字记录', async () => {
    const { run, sets } = makeRunner({ bypass: { 'Wi-Fi': ['localhost', '*.local'] } })
    const { added, failed } = await addBypassEntries(['ai.86links.dev'], { runCommand: run })
    expect(failed).toEqual([])
    expect(added).toEqual([
      { service: 'Wi-Fi', entries: ['ai.86links.dev', '*.ai.86links.dev'] },
      { service: 'iPhone USB', entries: ['ai.86links.dev', '*.ai.86links.dev'] },
    ])
    expect(sets).toEqual([
      'Wi-Fi: localhost,*.local,ai.86links.dev,*.ai.86links.dev',
      'iPhone USB: ai.86links.dev,*.ai.86links.dev',
    ])
  })

  it('既有更宽泛通配已覆盖时跳过追加，用户条目不记入追加记录', async () => {
    const { run, sets } = makeRunner({
      services: 'An asterisk (*) denotes that a network service is disabled.\nWi-Fi\n',
      bypass: { 'Wi-Fi': ['*.86links.dev'] },
    })
    const { added } = await addBypassEntries(['ai.86links.dev'], { runCommand: run })
    expect(added).toEqual([])
    expect(sets).toEqual([])
  })

  it('例外已完整覆盖时零改动（幂等）', async () => {
    const entries = ['ai.86links.dev', '*.ai.86links.dev']
    const { run, sets } = makeRunner({ bypass: { 'Wi-Fi': entries, 'iPhone USB': entries } })
    const { added, failed } = await addBypassEntries(['ai.86links.dev'], { runCommand: run })
    expect(added).toEqual([])
    expect(failed).toEqual([])
    expect(sets).toEqual([])
  })

  it('单服务 set 失败跳过该服务并继续其余，失败名单返回', async () => {
    const { run, sets } = makeRunner({ failSetFor: ['Wi-Fi'] })
    const { added, failed } = await addBypassEntries(['ai.86links.dev'], { runCommand: run })
    expect(sets).toEqual(['iPhone USB: ai.86links.dev,*.ai.86links.dev'])
    expect(added).toEqual([{ service: 'iPhone USB', entries: ['ai.86links.dev', '*.ai.86links.dev'] }])
    expect(failed).toEqual(['Wi-Fi'])
  })
})

describe('removeBypassEntries', () => {
  it('只移除记录条目，保留其余；清空到零时走 Empty 通道', async () => {
    const { run, sets } = makeRunner({
      bypass: { 'Wi-Fi': ['localhost', 'ai.86links.dev', '*.ai.86links.dev'], 'iPhone USB': ['ai.86links.dev', '*.ai.86links.dev'] },
    })
    const records: BypassRecord[] = [
      { service: 'Wi-Fi', entries: ['ai.86links.dev', '*.ai.86links.dev'] },
      { service: 'iPhone USB', entries: ['ai.86links.dev', '*.ai.86links.dev'] },
    ]
    const failed = await removeBypassEntries(records, { runCommand: run })
    expect(failed).toEqual([])
    expect(sets).toEqual(['Wi-Fi: localhost', 'iPhone USB: (empty)'])
  })

  it('条目已不在列表（用户已手动清理）时不写回，服务失败计入失败名单', async () => {
    const { run, sets } = makeRunner({ bypass: { 'Wi-Fi': ['localhost'] }, failGetFor: ['iPhone USB'] })
    const failed = await removeBypassEntries(
      [
        { service: 'Wi-Fi', entries: ['ai.86links.dev'] },
        { service: 'iPhone USB', entries: ['ai.86links.dev'] },
      ],
      { runCommand: run },
    )
    expect(sets).toEqual([])
    expect(failed).toEqual(['iPhone USB'])
  })
})

describe('snapshot 与 sweep', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('快照写读回环；缺失文件读出 null；父目录缺失自动补建', () => {
    dir = mkdtempSync(join(tmpdir(), 'dv-sysproxy-'))
    const snapshotPath = join(dir, 'nested', 'proxy-bypass.json')
    expect(readBypassSnapshot({ snapshotPath })).toBeNull()
    const records = [{ service: 'Wi-Fi', entries: ['ai.86links.dev'] }]
    writeBypassSnapshot(records, { snapshotPath })
    expect(readBypassSnapshot({ snapshotPath })).toEqual(records)
  })

  it('损坏快照按 DvError 报出（内容非法不静默吞）', () => {
    dir = mkdtempSync(join(tmpdir(), 'dv-sysproxy-'))
    const snapshotPath = join(dir, 'proxy-bypass.json')
    writeFileSync(snapshotPath, '{broken', 'utf8')
    expect(() => readBypassSnapshot({ snapshotPath })).toThrow(/快照损坏/)
  })

  it('sweep 部分服务清扫失败时保留快照待重试，全成功才删除', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dv-sysproxy-'))
    const snapshotPath = join(dir, 'proxy-bypass.json')
    const { run } = makeRunner({ bypass: { 'Wi-Fi': ['stale.dev'] }, failSetFor: ['Wi-Fi'] })
    writeBypassSnapshot([{ service: 'Wi-Fi', entries: ['stale.dev'] }], { snapshotPath })
    await sweepStaleBypass({ runCommand: run, snapshotPath })
    expect(existsSync(snapshotPath)).toBe(true)
  })

  it('sweep 清扫残留：移除快照条目并删除快照文件', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dv-sysproxy-'))
    const snapshotPath = join(dir, 'proxy-bypass.json')
    const { run, sets } = makeRunner({ bypass: { 'Wi-Fi': ['keep.me', 'stale.dev'] } })
    writeBypassSnapshot([{ service: 'Wi-Fi', entries: ['stale.dev'] }], { snapshotPath })
    await sweepStaleBypass({ runCommand: run, snapshotPath })
    expect(sets).toEqual(['Wi-Fi: keep.me'])
    expect(existsSync(snapshotPath)).toBe(false)
  })

  it('无快照时 sweep 零命令零副作用', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dv-sysproxy-'))
    const { run, sets } = makeRunner({})
    await sweepStaleBypass({ runCommand: run, snapshotPath: join(dir, 'absent.json') })
    expect(sets).toEqual([])
  })
})