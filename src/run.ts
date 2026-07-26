import type { Readable, Writable } from 'node:stream'

import {
  DvError,
  buildAbbreviationMap,
  detectPackageManager,
  readProjectPackage,
  resolveCommand,
  resolveProjectDir,
  spawnScript,
} from './core/index.ts'
import type { DvHookContext, DvHookable, DvLogger } from './core/hooks.ts'

export interface RunOptions {
  /** 项目目录，缺省为 cwd */
  path?: string
  /** script 域过滤：只匹配名为 mode 或以 `mode:` 开头的 scripts */
  mode?: string
  /** 测试注入：替代 process.cwd() */
  cwd?: string
  /** 插件 hook 实例，缺省则无 hook 触发 */
  hooks?: DvHookable
  /** 插件输出面，缺省写 stderr */
  logger?: DvLogger
  stdin?: Readable
  stdout?: Writable
  stderr?: Writable
}

/** mode 过滤：候选 = 名 === mode 或以 `mode:` 开头的 scripts（决策 D1） */
export function filterScriptsByMode(
  scripts: Record<string, string>,
  mode: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(scripts).filter(([name]) => name === mode || name.startsWith(`${mode}:`)),
  )
}

/**
 * 候选表：script 名 + 缩写 + 命令文本。
 * 省记忆是 dv 的核心价值，报错时把可用入口完整摆出比一句 "not found" 有用得多。
 */
function formatCandidates(scripts: Record<string, string>): string {
  const abbrMap = buildAbbreviationMap(Object.keys(scripts))
  const abbrOf = new Map([...abbrMap].map(([abbr, name]) => [name, abbr]))
  return Object.entries(scripts)
    .map(([name, cmd]) => `    ${name} (${abbrOf.get(name)})  ${cmd}`)
    .join('\n')
}

/**
 * dv 主命令：解析 scripts → mode 过滤 → 解析链（全名>缩写>前缀唯一>歧义）→ spawn 透传。
 * 返回值为 exit code；可预期错误（DvError）输出到 stderr 并返回 1。
 */
export async function run(cmdName: string, options: RunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const logger: DvLogger = options.logger ?? {
    info: (msg) => stderr.write(`${msg}\n`),
    warn: (msg) => stderr.write(`${msg}\n`),
  }

  let ctx: DvHookContext | undefined
  try {
    const dir = resolveProjectDir(options.cwd ?? process.cwd(), options.path)
    const pkg = await readProjectPackage(dir)
    const mode = options.mode ?? 'dev'
    const candidates = filterScriptsByMode(pkg.scripts, mode)

    ctx = { dir, pkg, mode, logger }
    await options.hooks?.callHook('scripts:loaded', ctx)

    if (Object.keys(candidates).length === 0) {
      stderr.write(`dv: no scripts in mode "${mode}"\n`)
      return 1
    }

    const result = resolveCommand(cmdName, candidates)

    if (result.kind === 'none') {
      stderr.write(`dv: no script matching "${cmdName}" in mode "${mode}". Available:\n`)
      stderr.write(`${formatCandidates(candidates)}\n`)
      return 1
    }

    if (result.kind === 'ambiguous') {
      stderr.write(`dv: "${cmdName}" is ambiguous in mode "${mode}". Candidates:\n`)
      stderr.write(`${formatCandidates(Object.fromEntries(result.matches.map((m) => [m, candidates[m]])))}\n`)
      return 1
    }

    ctx.scriptName = result.name
    ctx.scriptText = candidates[result.name]
    await options.hooks?.callHook('command:resolved', ctx)

    const pm = await detectPackageManager(dir)

    await options.hooks?.callHook('command:before', ctx)
    const exitCode = await spawnScript(pm, result.name, {
      cwd: dir,
      stdin: options.stdin,
      stdout,
      stderr,
    })

    ctx.exitCode = exitCode
    await options.hooks?.callHook('command:after', ctx)
    return exitCode
  } catch (error) {
    if (error instanceof DvError) {
      stderr.write(`dv: ${error.message}\n`)
      return 1
    }
    // 非预期异常同样通知 error hook，插件可据此清理（如 kp 的超时守护）。
    // ctx 不存在说明异常发生在上下文构建前（此路径只抛 DvError，已在上支拦截）
    if (ctx) {
      ctx.error = error as Error
      try {
        await options.hooks?.callHook('command:error', ctx)
      } catch {
        // error hook 自身抛错不得掩盖原始异常
      }
    }
    throw error
  }
}
