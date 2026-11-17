import { afterEach, describe, expect, it } from 'vitest'
import { Doc, applyUpdateV2, mergeUpdatesV2, text } from '#y'
import { WebSocketServer } from 'ws'
import { SyncProvider, openTransport, type TransportEvent, type TransportOptions } from '#entry'
import { encodeHello } from '../core/protocol.js'
import { startServer, waitFor } from './helpers.js'
import { udpProxy } from './udp-proxy.js'

let cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

function client(options: TransportOptions, name = 'doc') {
  const transport = openTransport(options)
  const doc = new Doc()
  const provider = new SyncProvider(name, doc, transport)
  const events: TransportEvent[] = []
  transport.subscribe((e) => events.push(e))
  cleanup.push(() => {
    provider.destroy()
    transport.close()
  })
  return { transport, doc, provider, events }
}
const count = (events: TransportEvent[], type: TransportEvent['type']) =>
  events.filter((e) => e.type === type).length

const fast = { pingInterval: 50, idleTimeout: 200, minBackoff: 10, maxBackoff: 20 }

describe('client liveness check', () => {
  it('closes a WebSocket whose server goes silent after the handshake, and keeps retrying', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((r) => wss.once('listening', () => r()))
    // Answer the client's hello so the connection comes up, then never answer anything again.
    wss.on('connection', (ws) => ws.once('message', () => ws.send(encodeHello())))
    cleanup.push(() => new Promise<void>((r) => wss.close(() => r())))
    const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`
    const a = client({ mode: 'websocket', websocketUrl: url, ...fast })
    await waitFor(() => count(a.events, 'connected') >= 2, 'a reconnect after the idle timeout')
    expect(count(a.events, 'disconnected')).toBeGreaterThanOrEqual(1)
  })

  it('keeps a quiet but healthy connection open over WebSocket and WebTransport', async () => {
    const s = await startServer()
    cleanup.push(() => s.stop())
    for (const options of [
      { mode: 'websocket', websocketUrl: s.wsUrl },
      { mode: 'webtransport', ...s.wtOptions },
    ] as TransportOptions[]) {
      const a = client({ ...options, ...fast })
      await a.provider.whenSynced
      await new Promise((r) => setTimeout(r, 800)) // four idle timeouts with nothing to sync
      expect(count(a.events, 'connected')).toBe(1)
      expect(count(a.events, 'disconnected')).toBe(0)
    }
  })

  it('notices a WebTransport path that went silent and reconnects', async () => {
    const s = await startServer()
    cleanup.push(() => s.stop())
    const wtPort = Number(new URL(s.wtOptions.webTransportUrl!).port)
    const proxy = await udpProxy(wtPort)
    cleanup.push(() => proxy.close())
    const url = `https://127.0.0.1:${proxy.port}/sync`
    const a = client({ mode: 'webtransport', ...s.wtOptions, webTransportUrl: url, ...fast })
    await a.provider.whenSynced
    proxy.blackhole = true
    await waitFor(() => a.transport.status !== 'connected', 'the silent link to be dropped')
    proxy.blackhole = false
    await waitFor(() => a.transport.status === 'connected', 'reconnect once the path is back')
    expect(count(a.events, 'connected')).toBe(2)
  })
})

describe('connection migration', () => {
  it('keeps a WebTransport session when the client address changes', async () => {
    const s = await startServer()
    cleanup.push(() => s.stop())
    const proxy = await udpProxy(Number(new URL(s.wtOptions.webTransportUrl!).port))
    cleanup.push(() => proxy.close())
    const url = `https://127.0.0.1:${proxy.port}/sync`
    // Liveness checks are on, so a session that did not survive would show as a second connect.
    const a = client({ mode: 'webtransport', ...s.wtOptions, webTransportUrl: url, ...fast })
    const b = client({ mode: 'webtransport', ...s.wtOptions })
    await a.provider.whenSynced
    await b.provider.whenSynced
    const before = proxy.upstreamPort
    text(a.doc, 't').insert(0, 'one')
    await waitFor(() => text(b.doc, 't').toString() === 'one', 'first edit')
    await proxy.migrate()
    expect(proxy.upstreamPort).not.toBe(before)
    text(a.doc, 't').insert(3, ' two')
    await waitFor(() => text(b.doc, 't').toString() === 'one two', 'edit after migration')
    text(b.doc, 't').insert(7, ' three')
    await waitFor(
      () => text(a.doc, 't').toString() === 'one two three',
      'edit back after migration',
    )
    await new Promise((r) => setTimeout(r, 600))
    expect(count(a.events, 'connected')).toBe(1)
  })
})
