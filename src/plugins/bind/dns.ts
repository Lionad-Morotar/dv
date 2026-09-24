import dns2 from 'dns2'

const { Packet } = dns2

export interface DnsResponder {
  /** 实际监听端口（listen 0 由系统分配，经 listening 解析回读） */
  port: number
  close: () => Promise<void>
}

/** 可选输出面：socket 级故障（如端口被抢）经 warn 上报而非崩进程 */
export interface DnsResponderOptions {
  logger?: { warn: (msg: string) => void }
}

/** 查询名是否命中绑定域（含任意深度子域）；DNS 名大小写不敏感、可带尾点 */
export function matchesBoundDomain(queryName: string, domains: string[]): boolean {
  const q = queryName.toLowerCase().replace(/\.$/, '')
  return domains.some((d) => q === d || q.endsWith(`.${d}`))
}

/**
 * 绑定域的本地 DNS 应答器，配合 /etc/resolver/<domain> 把该域（含子域）路由到本机。
 * A 查询答 127.0.0.1；其余类型答 NODATA（NOERROR 空答案——名字存在但该类型无数据，
 * 避免 AAAA 答 ::1 而 dev server 只听 IPv4 的错配）；绑定域之外一律 REFUSED，
 * 本应答器只服务绑定域，绝不做转发（转发等于在自己进程里重实现系统递归解析器）。
 * TTL 取 0：绑定随 dv 进程生灭，缓存会让死绑定多活一段时间。
 */
export async function startDnsResponder(
  domains: string[],
  options: DnsResponderOptions = {},
): Promise<DnsResponder> {
  const normalized = domains.map((d) => d.toLowerCase().replace(/\.$/, ''))
  const server = dns2.createServer({
    udp: true,
    handle: (request, send) => {
      const response = Packet.createResponseFromRequest(request)
      const question = request.questions[0]
      // 多问题查询（QDCOUNT>1）整体拒答：只答其一会把绑定域外的问题混进响应
      if (!question || request.questions.length !== 1 || !matchesBoundDomain(question.name, normalized)) {
        response.header.rcode = Packet.RCODE.REFUSED
        sendQuietly(send, response)
        return
      }
      if (question.type === Packet.TYPE.A) {
        response.answers.push(
          Packet.createResourceFromQuestion(question, {
            type: Packet.TYPE.A,
            class: Packet.CLASS.IN,
            ttl: 0,
            address: '127.0.0.1',
          }),
        )
      }
      sendQuietly(send, response)
    },
  })
  // dns2 的 send 返回 promise（发送失败即 reject），丢弃会成 unhandledRejection 崩掉 dv；
  // 单次应答失败对调用方只是超时重试，吞掉即可
  function sendQuietly(send: (r: InstanceType<typeof Packet>) => unknown, response: InstanceType<typeof Packet>) {
    void Promise.resolve(send(response)).catch(() => {})
  }
  // 畸形查询包触发 requestError；socket 级故障（EADDRINUSE 等）经 error 事件上抛，
  // EventEmitter 无监听者即 throw，必须接住
  server.on('requestError', () => {})
  server.on('error', (error: Error) => {
    options.logger?.warn(`bind: dns responder error: ${error.message}`)
  })

  const addresses = await server.listen({ udp: { port: 0, address: '127.0.0.1' } })
  const port = addresses.udp?.port
  if (typeof port !== 'number') {
    throw new Error('dns responder failed to bind a udp port')
  }
  return {
    port,
    close: async () => {
      await server.close()
    },
  }
}
