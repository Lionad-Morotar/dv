import { afterEach, describe, expect, it } from 'vitest'
import { createSocket } from 'node:dgram'

import dns2 from 'dns2'

import { matchesBoundDomain, startDnsResponder, type DnsResponder } from '../src/plugins/bind/dns.ts'

const { Packet } = dns2

describe('matchesBoundDomain', () => {
  const domains = ['example.com', 'app.test']

  it('matches the apex domain itself', () => {
    expect(matchesBoundDomain('example.com', domains)).toBe(true)
    expect(matchesBoundDomain('app.test', domains)).toBe(true)
  })

  it('matches subdomains at any depth', () => {
    expect(matchesBoundDomain('a.example.com', domains)).toBe(true)
    expect(matchesBoundDomain('a.b.example.com', domains)).toBe(true)
  })

  it('is case-insensitive and tolerates a trailing dot', () => {
    expect(matchesBoundDomain('ExAmPlE.cOm', domains)).toBe(true)
    expect(matchesBoundDomain('example.com.', domains)).toBe(true)
  })

  it('rejects names outside the bound domains', () => {
    expect(matchesBoundDomain('other.com', domains)).toBe(false)
    // 后缀撞车不算子域：缺边界点
    expect(matchesBoundDomain('notexample.com', domains)).toBe(false)
    // 绑定域出现在中间也不算（它是别人的子域）
    expect(matchesBoundDomain('example.com.evil.com', domains)).toBe(false)
  })
})

describe('startDnsResponder', () => {
  let responder: DnsResponder | undefined

  afterEach(async () => {
    await responder?.close()
    responder = undefined
  })

  const query = (port: number, name: string, type: 'A' | 'AAAA' = 'A') =>
    dns2.UDPClient({ dns: '127.0.0.1', port, timeout: 800 })(name, type)

  it('listens on an ephemeral loopback port', async () => {
    responder = await startDnsResponder(['dv-test.invalid'])
    expect(responder.port).toBeGreaterThan(0)
  })

  it('answers A queries for the bound domain and its subdomains with 127.0.0.1', async () => {
    responder = await startDnsResponder(['dv-test.invalid'])
    const apex = await query(responder.port, 'dv-test.invalid')
    expect(apex.header.rcode).toBe(Packet.RCODE.NOERROR)
    expect(apex.answers).toHaveLength(1)
    expect(apex.answers[0].address).toBe('127.0.0.1')

    const sub = await query(responder.port, 'api.dv-test.invalid')
    expect(sub.answers[0].address).toBe('127.0.0.1')
  })

  it('answers NODATA (NOERROR, no answers) for non-A types on bound domains', async () => {
    responder = await startDnsResponder(['dv-test.invalid'])
    const aaaa = await query(responder.port, 'dv-test.invalid', 'AAAA')
    expect(aaaa.header.rcode).toBe(Packet.RCODE.NOERROR)
    expect(aaaa.answers).toHaveLength(0)
  })

  it('refuses queries outside the bound domains', async () => {
    responder = await startDnsResponder(['dv-test.invalid'])
    const outside = await query(responder.port, 'unbound.example')
    expect(outside.header.rcode).toBe(Packet.RCODE.REFUSED)
    expect(outside.answers).toHaveLength(0)
  })

  it('refuses multi-question queries instead of half-answering them', async () => {
    responder = await startDnsResponder(['dv-test.invalid'])
    const packet = new Packet()
    packet.header.id = Packet.uuid()
    packet.header.rd = 1
    packet.questions.push(
      new Packet.Question('dv-test.invalid', Packet.TYPE.A, Packet.CLASS.IN),
      new Packet.Question('unbound.example', Packet.TYPE.A, Packet.CLASS.IN),
    )
    const response = await new Promise<InstanceType<typeof Packet>>((resolveQuery, rejectQuery) => {
      const socket = createSocket('udp4')
      const timer = setTimeout(() => rejectQuery(new Error('timeout')), 800)
      socket.on('message', (data) => {
        clearTimeout(timer)
        socket.close()
        resolveQuery(Packet.parse(data))
      })
      socket.send(packet.toBuffer(), responder!.port, '127.0.0.1')
    })
    expect(response.header.rcode).toBe(Packet.RCODE.REFUSED)
  })

  it('stops answering after close()', async () => {
    responder = await startDnsResponder(['dv-test.invalid'])
    const { port } = responder
    await responder.close()
    responder = undefined
    await expect(query(port, 'dv-test.invalid')).rejects.toThrow()
  })
})
