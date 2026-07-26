import { describe, expect, it } from 'vitest'

import { parsePortFromScript } from '../src/plugins/killport/port.ts'

describe('parsePortFromScript', () => {
  it.each([
    { script: 'nuxt dev --port 3001', expected: 3001 },
    { script: 'nuxt dev --port=3001', expected: 3001 },
    { script: 'nuxt dev --host 0.0.0.0 --port 3001', expected: 3001 },
    { script: 'vite --port 5174', expected: 5174 },
    { script: 'vite -p 5174', expected: 5174 },
    { script: 'nuxt dev -p 3001', expected: 3001 },
    { script: 'PORT=3002 nuxt dev', expected: 3002 },
    { script: 'PORT=3002 HOST=0.0.0.0 nuxt dev', expected: 3002 },
    { script: 'nuxt dev', expected: null },
    { script: 'vite build', expected: null },
    // -p 在非框架命令上下文不视为端口（如 rsync -p、tar -p 保留权限的语义）
    { script: 'rsync -p 3001 ./dist', expected: null },
    // 越界与非法值
    { script: 'nuxt dev --port 0', expected: null },
    { script: 'nuxt dev --port 65536', expected: null },
    { script: 'nuxt dev --port abc', expected: null },
    { script: 'PORT=-1 nuxt dev', expected: null },
    // --port 优先级高于 PORT= 与 -p（显式长选项语义最明确）
    { script: 'PORT=1111 nuxt dev --port 3001 -p 3002', expected: 3001 },
  ])('$script -> $expected', ({ script, expected }) => {
    expect(parsePortFromScript(script)).toBe(expected)
  })
})
