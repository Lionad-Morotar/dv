import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { fileExists } from '../../core/pkg.ts'

export type FrameworkKind = 'vite' | 'nuxt'

/**
 * config 候选表：nuxt 优先于 vite 系——nuxt 项目两 config 并存时，
 * devServer.port 才是对外监听端口（nuxt 的 vite 跑 middleware 模式，其 server.port 无效）。
 */
const CONFIG_CANDIDATES: Array<{ file: string; kind: FrameworkKind }> = [
  { file: 'nuxt.config.ts', kind: 'nuxt' },
  { file: 'nuxt.config.mts', kind: 'nuxt' },
  { file: 'nuxt.config.js', kind: 'nuxt' },
  { file: 'vite.config.ts', kind: 'vite' },
  { file: 'vite.config.mts', kind: 'vite' },
  { file: 'vite.config.js', kind: 'vite' },
  { file: 'vite.config.mjs', kind: 'vite' },
  { file: 'astro.config.ts', kind: 'vite' },
  { file: 'astro.config.mts', kind: 'vite' },
  { file: 'astro.config.mjs', kind: 'vite' },
  { file: 'rsbuild.config.ts', kind: 'vite' },
  { file: 'rsbuild.config.mts', kind: 'vite' },
]

/** 在目录下按候选表找第一个存在的框架 config 文件并读入内容 */
export async function loadFrameworkConfig(
  dir: string,
): Promise<{ path: string; kind: FrameworkKind; code: string } | null> {
  for (const { file, kind } of CONFIG_CANDIDATES) {
    const path = join(dir, file)
    if (await fileExists(path)) {
      return { path, kind, code: await readFile(path, 'utf8') }
    }
  }
  return null
}

/**
 * 从框架 config 源码静态提取端口（不执行文件——config 可能 import 目标项目未安装的依赖）。
 * key 路径与 kind 绑定：nuxt 只认 devServer.port，vite 系只认 server.port。
 * 只接受对象直接子级的数字字面量；变量/表达式提取不到值，返回 null（宁缺不滥）。
 */
export function extractPortFromConfig(code: string, kind: FrameworkKind): number | null {
  const key = kind === 'nuxt' ? 'devServer' : 'server'
  return findDirectPort(stripComments(code), key)
}

/**
 * 剥离注释（以空格占位保持偏移），字符串/模板串内容原样保留。
 * 必须字符串感知：'http://a.com' 里的 // 不是注释。
 */
function stripComments(code: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < code.length) {
    const c = code[i]
    if (quote !== null) {
      out += c
      if (c === '\\' && i + 1 < code.length) {
        out += code[i + 1]
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (c === '/' && code[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        out += code[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * 找 `<key>: { ... }` 对象字面量直接子级的 `port: <数字>`。
 * brace 深度跟踪 + 字符串感知跳过：嵌套对象（如 server.hmr.port）不算，字符串里的 brace 不计深度。
 */
function findDirectPort(code: string, key: string): number | null {
  const keyRe = new RegExp(`(?:^|[^\\w$])['"]?${key}['"]?\\s*:\\s*{`, 'g')
  const keyMatch = keyRe.exec(code)
  if (keyMatch === null) return null

  // 从 key 后 { 的位置开始，depth=1；只有 depth===1 的 port 才是直接子级
  let i = keyMatch.index + keyMatch[0].length
  let depth = 1
  let quote: string | null = null
  while (i < code.length && depth > 0) {
    const c = code[i]
    if (quote !== null) {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (depth === 1 && (c === 'p' || c === '"' || c === "'")) {
      const rest = code.slice(i)
      const portMatch = /^['"]?port['"]?\s*:\s*(\d+)/.exec(rest)
      if (portMatch !== null) {
        const port = Number(portMatch[1])
        return port >= 1 && port <= 65535 ? port : null
      }
      // port 存在但非数字字面量（变量/表达式）——提取不到值，不再继续找
      if (/^['"]?port['"]?\s*:/.test(rest)) return null
    }
    i++
  }
  return null
}
