import { lookup } from 'node:dns/promises'

import { DvError } from '../../core/pkg.ts'
import { resolvePort } from '../../core/port/index.ts'
import type { DvHookContext } from '../../core/hooks.ts'
import type { DvPlugin } from '../types.ts'
import { startDnsResponder } from './dns.ts'
import { spawnBindHelper, type BindHelper, type SpawnHelperOptions } from './helper.ts'
import { startBindProxy } from './proxy.ts'

export type BindCleanup = () => Promise<void>

export interface BindDeps {
  /** 默认 sudo 拉起 root helper；测试注入假实现绕开特权 */
  spawnHelper?: (options: SpawnHelperOptions) => Promise<BindHelper>
  /** 默认走系统解析（getaddrinfo，识别 /etc/resolver）；测试注入避免触网 */
  lookupHost?: (domain: string) => Promise<string | null>
  verifyTimeoutMs?: number
  verifyIntervalMs?: number
}

/**
 * 系统解析自验证必须用 lookup（getaddrinfo → mDNSResponder → /etc/resolver）；
 * dns.resolve 走 c-ares 直读 /etc/resolv.conf，永远看不到 per-domain resolver，
 * 用它验证会得出恒失败的假阴性。
 */
const systemLookup = async (domain: string): Promise<string | null> => {
  try {
    // 单次 lookup 设硬上限：getaddrinfo 经 mDNSResponder 的阻塞时长不受轮询
    // deadline 约束，没有这层的话一次 DROP 就能把自验证拖到系统解析超时
    const { address } = await Promise.race([
      lookup(domain, { family: 4 }),
      new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('lookup timeout')), 2000)),
    ])
    return address
  } catch {
    return null
  }
}

async function verifyBinding(
  domains: string[],
  deps: Required<Pick<BindDeps, 'lookupHost'>> & Pick<BindDeps, 'verifyTimeoutMs' | 'verifyIntervalMs'>,
): Promise<boolean> {
  const deadline = Date.now() + (deps.verifyTimeoutMs ?? 5000)
  const interval = deps.verifyIntervalMs ?? 200
  // 缓存刷新与 mDNSResponder 重载有延迟，窗口内轮询到全域名解析为 127.0.0.1 为止
  while (Date.now() < deadline) {
    const results = await Promise.all(domains.map((domain) => deps.lookupHost(domain)))
    if (results.every((address) => address === '127.0.0.1')) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}

/**
 * 绑定编排：解析端口 → 起 DNS 应答器与代理 → sudo 拉起 root helper → 自验证。
 * 绑定必须显式成功：解析不到端口或自验证失败都抛 DvError（静默降级等于把
 * --bind 参数吞掉，用户面对的是一个看似生效实际没有的系统变更）。
 * 返回清理函数；任何中段失败先回滚已启动的部件再抛出。
 */
export async function runBind(ctx: DvHookContext, deps: BindDeps = {}): Promise<BindCleanup | null> {
  const domains = ctx.bind
  if (!domains?.length) return null

  const port = await resolvePort(ctx)
  if (port === null) {
    throw new DvError(
      `bind: 无法解析 "${ctx.scriptName}" 的端口——在 package.json 加 "dv.killport.${ctx.scriptName}" 声明，或在脚本命令行显式写 --port`,
    )
  }

  const dns = await startDnsResponder(domains, { logger: ctx.logger }).catch((error: Error) => {
    throw new DvError(`bind: DNS 应答器启动失败——${error.message}`)
  })
  const proxy = await startBindProxy(port, { logger: ctx.logger }).catch(async (error: Error) => {
    // 代理失败时 DNS 已起，必须一并回滚——半启动状态只能靠进程退出兜底，太脏
    await dns.close()
    throw new DvError(`bind: 代理启动失败——${error.message}`)
  })
  const spawnHelper = deps.spawnHelper ?? spawnBindHelper

  const teardown = async (helper?: BindHelper) => {
    helper?.stop()
    await Promise.all([dns.close(), proxy.close()])
  }

  let helper: BindHelper
  try {
    helper = await spawnHelper({ proxyPort: proxy.port, dnsPort: dns.port, domains })
  } catch (error) {
    await teardown()
    throw error
  }

  const lookupHost = deps.lookupHost ?? systemLookup
  const verified = await verifyBinding(domains, {
    lookupHost,
    verifyTimeoutMs: deps.verifyTimeoutMs,
    verifyIntervalMs: deps.verifyIntervalMs,
  })
  if (!verified) {
    await teardown(helper)
    throw new DvError(
      `bind: 自验证失败——${domains.join('、')} 未解析到 127.0.0.1（resolver 未生效或被系统策略拦截）`,
    )
  }

  ctx.logger.info(`bind: ${domains.map((d) => `http://${d}`).join(' ')} → 127.0.0.1:${port}`)
  return () => teardown(helper)
}

/**
 * bind 插件：command:before 完成绑定编排，command:after/error 清理。
 * helper 的 watchdog 兜底 dv 崩溃路径；正常退出走这里的显式清理。
 */
export const bindPlugin: DvPlugin = {
  name: 'bind',
  description: 'Bind domains to the dev server via /etc/resolver, embedded DNS and a root :80 pipe',
  setup(hooks) {
    let cleanup: BindCleanup | null = null
    hooks.hook('command:before', async (ctx) => {
      cleanup = await runBind(ctx)
    })
    const teardownHook = async () => {
      await cleanup?.()
      cleanup = null
    }
    hooks.hook('command:after', teardownHook)
    hooks.hook('command:error', teardownHook)
  },
}
