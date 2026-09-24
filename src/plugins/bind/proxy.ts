import { createServer, type Server } from 'node:http'
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

import httpProxy from 'http-proxy-3'

export interface BindProxy {
  /** 实际监听端口（listen 0 由系统分配） */
  port: number
  close: () => Promise<void>
}

export interface BindProxyOptions {
  logger?: { warn: (msg: string) => void }
}

/**
 * 绑定域的本地反向代理：把到达绑定域的流量转发给 dev server。
 * Host 经 changeOrigin 重写为 127.0.0.1:<port>——vite 等框架的 Host 校验对 loopback
 * 字面量放行，绑定域由此零配置可用；Origin 同样同源化（vite 的 WS Origin 检查要求
 * Origin 与 Host 同源，只改 Host 会让 HMR 握手被 403）；原域名留在 X-Forwarded-Host，
 * 供框架生成对外绝对 URL。
 */
export async function startBindProxy(
  targetPort: number,
  options: BindProxyOptions = {},
): Promise<BindProxy> {
  const targetHost = `127.0.0.1:${targetPort}`
  const targetOrigin = `http://${targetHost}`

  const proxy = httpProxy.createProxyServer({
    target: targetOrigin,
    changeOrigin: true,
    xfwd: true,
    ws: true,
  })

  const rewriteOrigin = (proxyReq: ClientRequest, req: IncomingMessage) => {
    if (req.headers.origin !== undefined) {
      proxyReq.setHeader('origin', targetOrigin)
    }
  }
  proxy.on('proxyReq', rewriteOrigin)
  proxy.on('proxyReqWs', rewriteOrigin)

  proxy.on('error', (error: Error & { code?: string }, _req: IncomingMessage, res?: ServerResponse | Socket) => {
    // dev server 未就绪/重启中是常态（kp 清场后、HMR 重启间隙），回 502 让浏览器重试而非崩掉 dv
    options.logger?.warn(`bind: proxy error: ${error.message}`)
    if (res && 'writeHead' in res && typeof res.writeHead === 'function') {
      const response = res as ServerResponse
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      response.end('bind: dev server unreachable')
    } else if (res && typeof (res as Socket).end === 'function') {
      ;(res as Socket).end()
    }
  })

  const server: Server = createServer((req, res) => {
    proxy.web(req, res)
  })

  // 浏览器 keep-alive 与 WS 长连接会让 server.close() 空等对端关闭——
  // dv 关停必须即时，跟踪全部连接在 close 时主动 destroy
  const sockets = new Set<Socket>()
  const track = (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  }
  server.on('connection', track)
  server.on('upgrade', (req, socket: Socket, head: Buffer) => {
    track(socket)
    proxy.ws(req, socket, head)
  })

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('bind proxy failed to bind a port')
  }

  return {
    port: address.port,
    close: async () => {
      proxy.close()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise())
      })
    },
  }
}
