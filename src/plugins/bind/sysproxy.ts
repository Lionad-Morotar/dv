import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { DvError } from '../../core/pkg.ts'

const runExec = promisify(execFile)

export interface SystemProxyState {
  /** HTTP / HTTPS / SOCKS 任一开启即为 true */
  enabled: boolean
  /** PAC 模式例外列表不生效，无法静态注入，只能提示用户在代理工具侧配置 */
  pac: boolean
  exceptions: string[]
}

/** 单个网络服务上由 dv 追加的例外条目，退出恢复与崩溃清扫都以它为准 */
export interface BypassRecord {
  service: string
  entries: string[]
}

export interface SysProxyDeps {
  /** 默认 execFile 真实调用；测试注入桩避免触真机系统配置 */
  runCommand?: (file: string, args: string[]) => Promise<string>
  /** 默认 ~/Library/Application Support/dv/proxy-bypass.json */
  snapshotPath?: string
}

/** 默认 scutil --proxy 聚合视图 + 逐服务 networksetup 修改；snapshot 落 dv 用户目录 */
export function defaultSnapshotPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'dv', 'proxy-bypass.json')
}

/** scutil --proxy 输出的 plist 风格文本：标量行 `Key : value`，数组段为 Key/条目/右花括号三段式 */
export function parseScutilProxy(output: string): SystemProxyState {
  const scalars = new Map<string, string>()
  const arrays = new Map<string, string[]>()
  let currentArray: string | null = null
  for (const line of output.split('\n')) {
    const arrayHead = line.match(/^\s*([\w]+) : <array> \{$/)
    if (arrayHead) {
      currentArray = arrayHead[1]
      arrays.set(currentArray, [])
      continue
    }
    if (/^\s*\}$/.test(line)) {
      currentArray = null
      continue
    }
    const item = line.match(/^\s*\d+ : (.*)$/)
    if (item && currentArray) {
      arrays.get(currentArray)?.push(item[1])
      continue
    }
    const scalar = line.match(/^\s*([\w]+) : (.*)$/)
    if (scalar) scalars.set(scalar[1], scalar[2])
  }
  const flag = (key: string) => scalars.get(key) === '1'
  return {
    // PAC 也算代理在管流量：纯 PAC 模式下例外列表不生效，但必须让编排层走到警告分支
    // 而不是静默 return——否则纯 PAC 用户绑定域被劫持且得不到任何提示
    enabled: flag('HTTPEnable') || flag('HTTPSEnable') || flag('SOCKSEnable') || flag('ProxyAutoConfigEnable'),
    pac: flag('ProxyAutoConfigEnable'),
    exceptions: arrays.get('ExceptionsList') ?? [],
  }
}

/**
 * Chromium 风格例外匹配：精确相等（大小写不敏感）、`*.后缀` 覆盖多级子域、
 * `*` 全捕获、`<local>` 只覆盖无点主机名。
 */
export function bypassCoversDomain(exceptions: string[], host: string): boolean {
  const lower = host.toLowerCase()
  return exceptions.some((raw) => {
    const entry = raw.trim().toLowerCase()
    if (entry === '*') return true
    if (entry === '<local>') return !lower.includes('.')
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2)
      return lower.endsWith(`.${suffix}`)
    }
    return entry === lower
  })
}

/** 每个绑定域产出「自身 + 一级泛子域」两条目，与证书 SAN 策略同构，覆盖两种匹配语义 */
export function desiredEntries(domains: string[]): string[] {
  const normalized = domains.map((d) => d.toLowerCase().replace(/\.$/, ''))
  return normalized.flatMap((domain) => [domain, `*.${domain}`])
}

async function run(deps: SysProxyDeps, file: string, args: string[]): Promise<string> {
  const exec = deps.runCommand ?? ((f, a) => runExec(f, a).then((r) => r.stdout))
  return exec(file, args)
}

async function listEnabledServices(deps: SysProxyDeps): Promise<string[]> {
  const output = await run(deps, 'networksetup', ['-listallnetworkservices'])
  return output
    .split('\n')
    .slice(1) // 首行是星号说明
    .map((line) => line.trim())
    .filter((name) => name.length > 0 && !name.startsWith('*'))
}

async function getBypassEntries(deps: SysProxyDeps, service: string): Promise<string[]> {
  const output = await run(deps, 'networksetup', ['-getproxybypassdomains', service])
  // 空列表与错误都以文本行返回（"There aren't any…" / "** Error: …"），不是域名的一律剔除
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('**') && !line.includes("aren't any"))
}

async function setBypassEntries(deps: SysProxyDeps, service: string, entries: string[]): Promise<void> {
  // networksetup 约定：单个 "Empty" 参数即清空例外列表
  const args = entries.length > 0 ? ['-setproxybypassdomains', service, ...entries] : ['-setproxybypassdomains', service, 'Empty']
  await run(deps, 'networksetup', args)
}

/**
 * 判断例外列表是否已覆盖某条目：裸域看自身，泛域看其下任一子域主机。
 * 用于注入去重——已有更宽泛的通配（如 *.86links.dev）时跳过追加，
 * 且不把用户既有条目记入 dv 的追加记录（退出恢复时才不会误删）。
 */
function entryCovered(current: string[], entry: string): boolean {
  const probe = entry.startsWith('*.') ? `sub.${entry.slice(2)}` : entry
  return bypassCoversDomain(current, probe)
}

/**
 * 把绑定域 merge 进每个 enabled 服务的例外列表。
 * 已被既有条目覆盖的条目跳过（幂等），返回值区分成功追加（退出时据此移除）与失败服务。
 */
export async function addBypassEntries(
  domains: string[],
  deps: SysProxyDeps = {},
): Promise<{ added: BypassRecord[]; failed: string[] }> {
  const want = desiredEntries(domains)
  const added: BypassRecord[] = []
  const failed: string[] = []
  for (const service of await listEnabledServices(deps)) {
    try {
      const current = await getBypassEntries(deps, service)
      const missing = want.filter((entry) => !entryCovered(current, entry))
      if (missing.length === 0) continue
      await setBypassEntries(deps, service, [...current, ...missing])
      added.push({ service, entries: missing })
    } catch {
      failed.push(service)
    }
  }
  return { added, failed }
}

/**
 * 按记录精确移除例外条目——只动 dv 自己追加的部分，用户在绑定窗口内的其余改动原样保留。
 * 返回清理失败的服务名（调用方 warn），条目已不在列表视为已清理不写回。
 */
export async function removeBypassEntries(records: BypassRecord[], deps: SysProxyDeps = {}): Promise<string[]> {
  const failed: string[] = []
  for (const record of records) {
    try {
      const current = await getBypassEntries(deps, record.service)
      const removed = current.filter((entry) => record.entries.some((target) => target.toLowerCase() === entry.toLowerCase()))
      if (removed.length === 0) continue
      const rest = current.filter((entry) => !record.entries.some((target) => target.toLowerCase() === entry.toLowerCase()))
      await setBypassEntries(deps, record.service, rest)
    } catch {
      failed.push(record.service)
    }
  }
  return failed
}

/** 崩溃残留快照：仅记录 dv 追加的条目，恢复时按记录逐条移除，绝不回写全量列表 */
export function writeBypassSnapshot(records: BypassRecord[], deps: SysProxyDeps = {}): void {
  const path = deps.snapshotPath ?? defaultSnapshotPath()
  // dv 目录在首次 bind 时可能尚未创建（CA 目录要晚一步才落），不补建则首跑写盘 ENOENT
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, added: records }), { mode: 0o600 })
}

export function readBypassSnapshot(deps: SysProxyDeps = {}): BypassRecord[] | null {
  const path = deps.snapshotPath ?? defaultSnapshotPath()
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const added = (parsed as { added?: unknown })?.added
    if (!Array.isArray(added)) throw new Error('added 字段缺失')
    return added as BypassRecord[]
  } catch (error) {
    throw new DvError(`bind: 代理例外快照损坏（${(error as Error).message}）——已按无残留处理`)
  }
}

/**
 * 清扫上次崩溃残留的代理例外：读快照逐条移除后删除快照文件。
 * 无快照零副作用；快照损坏视为无残留（删除文件防永久卡死）。
 */
export async function sweepStaleBypass(deps: SysProxyDeps = {}): Promise<void> {
  const path = deps.snapshotPath ?? defaultSnapshotPath()
  let records: BypassRecord[] | null
  try {
    records = readBypassSnapshot({ snapshotPath: path })
  } catch {
    rmSync(path, { force: true })
    return
  }
  if (!records) return
  // 部分服务清扫失败时保留快照：删掉就永久失去清扫依据，下次 bind 重试（移除幂等）
  const failed = await removeBypassEntries(records, deps)
  if (failed.length === 0) rmSync(path, { force: true })
}

/** scutil --proxy 聚合读视图（编排层据此决定是否注入与是否提示 PAC） */
export async function detectSystemProxy(deps: SysProxyDeps = {}): Promise<SystemProxyState> {
  return parseScutilProxy(await run(deps, 'scutil', ['--proxy']))
}

/**
 * 编排层消费的系统代理缝：快照写清收在钩子内部，
 * 让测试可以整组注入桩而不触真机系统配置。
 */
export interface SysProxyHooks {
  sweep: () => Promise<void>
  detect: () => Promise<SystemProxyState>
  add: (domains: string[]) => Promise<{ added: BypassRecord[]; failed: string[] }>
  /** 返回清理失败的服务名；全部成功时清掉快照（部分失败保留待下次 bind 重试清扫） */
  remove: (records: BypassRecord[]) => Promise<string[]>
}

export function defaultSysProxyHooks(deps: SysProxyDeps = {}): SysProxyHooks {
  return {
    sweep: () => sweepStaleBypass(deps),
    detect: () => detectSystemProxy(deps),
    add: async (domains) => {
      const result = await addBypassEntries(domains, deps)
      // 快照先于绑定流程落盘：从注入成功那一刻起崩溃就有清扫依据。
      // 快照写失败不推翻注入——追加记录已随返回值交回调用方，进程内恢复仍然成立
      if (result.added.length > 0) {
        try {
          writeBypassSnapshot(result.added, deps)
        } catch {
          /* 快照落盘失败仅损失崩溃清扫依据，见上 */
        }
      }
      return result
    },
    remove: async (records) => {
      const failed = await removeBypassEntries(records, deps)
      if (failed.length === 0) rmSync(deps.snapshotPath ?? defaultSnapshotPath(), { force: true })
      return failed
    },
  }
}