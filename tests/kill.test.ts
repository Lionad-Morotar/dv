import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'

import { killProcessOnPort } from '../src/plugins/killport/kill.ts'
import { exitOf, occupyPort } from './helpers.ts'

const TEST_PORT = 53991

/** 验证端口可重新绑定（kill 生效的终态证据） */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer()
    server.once('error', () => resolvePromise(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolvePromise(true))
    })
  })
}

describe('killProcessOnPort', () => {
  it('returns an empty list when the port is free', async () => {
    expect(await killProcessOnPort(59998)).toEqual([])
  })

  it('kills the listener and frees the port', async () => {
    const child = await occupyPort(TEST_PORT)
    const exited = exitOf(child)

    const pids = await killProcessOnPort(TEST_PORT)
    expect(pids).toContain(child.pid)

    const exit = await exited
    expect(exit.signal).toBe('SIGTERM')
    // killProcessOnPort 返回即承诺端口可用（内部已等待释放），调用方无需轮询
    expect(await canBind(TEST_PORT)).toBe(true)
  }, 15000)
})
