import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer as createHttpServer, request, type IncomingMessage, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'

import { startBindProxy, type BindProxy } from '../src/plugins/bind/proxy.ts'

/** 回声靶场：HTTP 回显到达头，upgrade 后裸管道回声（代理职责边界是 upgrade + 透传，不是 WS 帧语义） */
interface Target {
  port: number
  seen: Array<{ host?: string; origin?: string; forwardedHost?: string; url?: string }>
  close: () => Promise<void>
}

async function startTarget(): Promise<Target> {
  const seen: Target['seen'] = []
  const sockets = new Set<Socket>()
  const server: Server = createHttpServer((req, res) => {
    seen.push({
      host: req.headers.host,
      origin: req.headers.origin,
      forwardedHost: req.headers['x-forwarded-host'] as string | undefined,
      url: req.url,
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    seen.push({ host: req.headers.host, origin: req.headers.origin, url: req.url })
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    if (head.length > 0) socket.unshift(head)
    sockets.add(socket)
    socket.on('data', (chunk) => socket.write(chunk))
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('connection', (socket) => sockets.add(socket))
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no target port')
  return {
    port: address.port,
    seen,
    close: () =>
      new Promise<void>((resolvePromise) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolvePromise())
      }),
  }
}

function httpGet(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      },
    )
    req.on('error', rejectPromise)
    req.end()
  })
}

describe('startBindProxy', () => {
  let proxy: BindProxy | undefined
  let target: Target | undefined

  afterEach(async () => {
    await proxy?.close()
    await target?.close()
    proxy = undefined
    target = undefined
  })

  it('forwards HTTP with Host rewritten to the loopback target', async () => {
    target = await startTarget()
    proxy = await startBindProxy(target.port)
    const { status } = await httpGet(proxy.port, { host: 'dv-test.invalid' })
    expect(status).toBe(200)
    expect(target.seen[0].host).toBe(`127.0.0.1:${target.port}`)
  })

  it('rewrites Origin to the target origin and preserves the public host in X-Forwarded-Host', async () => {
    target = await startTarget()
    proxy = await startBindProxy(target.port)
    await httpGet(proxy.port, { host: 'dv-test.invalid', origin: 'http://dv-test.invalid' })
    expect(target.seen[0].origin).toBe(`http://127.0.0.1:${target.port}`)
    expect(target.seen[0].forwardedHost).toBe('dv-test.invalid')
  })

  it('upgrades WebSocket with rewritten Host/Origin and pipes bytes both ways', async () => {
    target = await startTarget()
    proxy = await startBindProxy(target.port)
    const socket = connect(proxy.port, '127.0.0.1')
    await new Promise<void>((resolvePromise) => socket.on('connect', resolvePromise))
    socket.write(
      'GET / HTTP/1.1\r\n' +
        'Host: dv-test.invalid\r\n' +
        'Origin: http://dv-test.invalid\r\n' +
        'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    )
    const upgraded = await new Promise<Buffer>((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = []
      const onData = (chunk: Buffer) => {
        chunks.push(chunk)
        const buf = Buffer.concat(chunks)
        if (buf.includes('\r\n\r\n')) {
          socket.off('data', onData)
          resolvePromise(buf)
        }
      }
      socket.on('data', onData)
      socket.on('error', rejectPromise)
      setTimeout(() => rejectPromise(new Error('upgrade timeout')), 2000)
    })
    expect(upgraded.toString()).toContain('101')
    expect(target.seen[0].host).toBe(`127.0.0.1:${target.port}`)
    expect(target.seen[0].origin).toBe(`http://127.0.0.1:${target.port}`)

    const echoed = new Promise<Buffer>((resolvePromise) => socket.once('data', resolvePromise))
    socket.write('ping-payload')
    expect((await echoed).toString()).toBe('ping-payload')
    socket.destroy()
  })

  it('answers 502 instead of crashing when the dev server is unreachable', async () => {
    proxy = await startBindProxy(1) // 端口 1 无人监听
    const { status } = await httpGet(proxy.port, { host: 'dv-test.invalid' })
    expect(status).toBe(502)
  })
})
