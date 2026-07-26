#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

import { cac } from 'cac'
import { createHooks } from 'hookable'

import { run } from './run.ts'
import { pluginsCommand } from './commands/plugins.ts'
import { BUILTIN_PLUGINS, registerPlugins } from './plugins/registry.ts'
import { resolveConfigPath } from './plugins/state.ts'
import type { DvHooks } from './core/hooks.ts'

// dist/cli.mjs 与 src/cli.ts 都位于包根下一层，包根 package.json 始终随 npm 包分发；
// 读取失败（如 cli.mjs 被单独拷出包目录）降级为 unknown 而非整个 CLI 崩溃
let version = 'unknown'
try {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  if (typeof pkg.version === 'string') {
    version = pkg.version
  }
} catch {
  // 容错见上
}

const cli = cac('dv')

// 无名命令作为默认命令：<cmd> 是 script 引用而非子命令名，
// 未命中 plugins 等命名命令的输入一律进入 script 匹配流程
cli
  .command('<cmd>', 'Run an npm script by full name or shortest unique prefix')
  .action(async (cmdName: string, options: { path?: string; mode: string }) => {
    const hooks = createHooks<DvHooks>()
    await registerPlugins(hooks, BUILTIN_PLUGINS, resolveConfigPath())
    process.exitCode = await run(cmdName, { path: options.path, mode: options.mode, hooks })
  })

// --path/--mode 注册为全局选项：帮助输出可见（需求侧把它们视为 dv 的公共入口面），
// 且未来其他命名命令（如 plugins 之外的）也能复用同一套项目定位参数
cli.option('--path <path>', 'Project directory (default: cwd)')
cli.option('--mode <mode>', 'Script scope filter: dev | build', { default: 'dev' })

cli
  .command('plugins [sub] [name]', 'Manage plugins: list | enable | disable (default: list)')
  .action(async (sub: string | undefined, name?: string) => {
    // sub 缺省按 git remote 惯例默认 list——必需参数缺失只会让 cac 抛 CACError 堆栈
    process.exitCode = await pluginsCommand(sub ?? 'list', name)
  })

cli.help()
cli.version(version)

// 裸 `dv` 输出帮助；cac 仅在命名命令未匹配时落入默认命令，无参数时二者都不触发。
// 不用 process.exit：stdout 为 pipe 时异步缓冲可能被 exit 截断。
// 空 argv 必须跳过 parse——默认命令的 <cmd> 是必需位置参数，空 argv 走 parse 会抛 CACError
if (process.argv.slice(2).length === 0) {
  cli.outputHelp()
} else {
  cli.parse()
}
