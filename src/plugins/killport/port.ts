/**
 * 从 npm script 文本提取显式声明的端口。
 * 只覆盖确定无疑的写法；提取不到返回 null（决策 D3/D10：宁缺不滥，null = kp 不动作）。
 */

/** 已知框架命令：只有 script 含其一，才把短选项 -p 解释为端口（防 rsync/tar 等 -p 误判） */
const FRAMEWORK_COMMANDS = /\b(?:nuxt|nuxi|vite|astro|next|remix|rsbuild|storybook)\b/

function toPort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const port = Number(raw)
  return port >= 1 && port <= 65535 ? port : null
}

export function parsePortFromScript(scriptText: string): number | null {
  // 优先级 --port > PORT= > -p：长选项语义最明确，环境变量次之，短选项最易误判
  const longPort = /(?:^|\s)--port[ =](\S+)/.exec(scriptText)
  if (longPort) {
    return toPort(longPort[1].replace(/["']/g, ''))
  }

  const envPort = /(?:^|\s)PORT=(\S+)/.exec(scriptText)
  if (envPort) {
    return toPort(envPort[1].replace(/["']/g, ''))
  }

  if (FRAMEWORK_COMMANDS.test(scriptText)) {
    const shortPort = /(?:^|\s)-p[ =]?(\d+)/.exec(scriptText)
    if (shortPort) {
      return toPort(shortPort[1])
    }
  }

  return null
}
