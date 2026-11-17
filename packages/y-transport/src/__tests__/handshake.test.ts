import { afterEach, describe, expect, it } from 'vitest'
import { Doc, applyUpdateV2, mergeUpdatesV2, text } from '#y'
import { WebSocket, WebSocketServer } from 'ws'
import { WebTransport } from '@fails-components/webtransport'
import {
  ProtocolVersionError,
  SyncProvider,
  openTransport,
  type TransportEvent,
  type TransportOptions,
} from '#entry'
import type { Link, WebTransportSessionLike } from '../core/link.js'
import {
  LOCAL_VERSIONS,
  MSG_SYNC,
  decodeFrame,
  decodeHello,
  encodeFrame,
  encodeHello,
  negotiateVersion,
  type VersionRange,
} from '../core/protocol.js'
import type { SyncServer, SyncServerOptions } from '#server'
import { attachWebSocketServer } from '../server/ws.js'
import { serveWebTransport } from '../server/webtransport.js'
import { selfSignedCertificate, startServer, waitFor } from './helpers.js'

let cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

/** A server from another version: answers every client's first message with `reply` (or not at all). */
async function foreignServer(reply: (link: Link) => void) {
  const fake = {
    accept(link: Link) {
      link.onFrame = () => {
        link.onFrame = null
        reply(link)
      }
    },
  } as unknown as SyncServer
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  attachWebSocketServer(fake, wss, { heartbeat: 0 })
  const { cert, privKey, hash } = selfSignedCertificate()
  const endpoint = await serveWebTransport(fake, { port: 0, host: '127.0.0.1', cert, privKey })
  cleanup.push(async () => {
    for (const ws of wss.clients) ws.terminate()
    await endpoint.close()
    await new Promise<void>((r) => wss.close(() => r()))
  })
  return {
    websocketUrl: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    webTransportUrl: `https://127.0.0.1:${endpoint.port}/sync`,
    webTransportOptions: { serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }] },
    WebTransport: WebTransport as unknown as new (
      url: string,
      options?: unknown,
    ) => WebTransportSessionLike,
  }
}

function client(options: TransportOptions) {
  const transport = openTransport({ minBackoff: 20, maxBackoff: 50, ...options })
  const events: TransportEvent[] = []
  transport.subscribe((e) => events.push(e))
  const provider = new SyncProvider('doc', new Doc(), transport)
  cleanup.push(() => {
    provider.destroy()
    transport.close()
  })
  return { transport, provider, events }
}

const errors = (events: TransportEvent[]) => events.flatMap((e) => (e.type === 'error' ? [e] : []))

describe('version negotiation', () => {
  it('picks the highest version both ranges contain', () => {
    expect(negotiateVersion({ min: 1, max: 3 }, { min: 2, max: 5 })).toBe(3)
    expect(negotiateVersion({ min: 1, max: 1 }, { min: 1, max: 1 })).toBe(1)
    expect(negotiateVersion({ min: 1, max: 1 }, { min: 2, max: 2 })).toBeNull()
    expect(negotiateVersion({ min: 3, max: 4 }, { min: 1, max: 2 })).toBeNull()
  })

  it('reads a hello with trailing bytes and nothing else as one', () => {
    const hello = encodeHello({ min: 2, max: 7 })
    expect(decodeHello(Uint8Array.from([...hello, 1, 2, 3]))).toEqual({ min: 2, max: 7 })
    expect(decodeHello(encodeFrame('doc', MSG_SYNC, new Uint8Array([0])))).toBeNull()
    expect(decodeHello(encodeHello({ min: 3, max: 2 }))).toBeNull()
    expect(decodeHello(encodeHello({ min: 0, max: 1 }))).toBeNull()
    expect(decodeHello(new Uint8Array([200]))).toBeNull()
  })

  it('is dropped by a server from before the handshake without reaching authorize or a room', () => {
    // A pre-handshake server parses every message with this same decodeFrame and drops it on null
    // or on a document name over 1024 characters, before it authorizes or opens anything.
    const hello = encodeHello()
    expect(decodeFrame(hello)).toBeNull()
    // Inside a larger buffer (a pooled Buffer) the read does not run out, but the name is too long.
    const pooled = new Uint8Array(4096)
    pooled.set(hello)
    const frame = decodeFrame(pooled.subarray(0, hello.length))
    expect(frame === null || frame.doc.length > 1024).toBe(true)
  })
})

describe.each(['websocket', 'webtransport'] as const)('client handshake over %s', (kind) => {
  const mode = (s: Awaited<ReturnType<typeof foreignServer>>): TransportOptions =>
    kind === 'websocket'
      ? { mode: 'websocket', websocketUrl: s.websocketUrl }
      : { mode: 'webtransport', ...s, websocketUrl: undefined }

  it('reports a server that speaks no common version and never syncs', async () => {
    const theirs: VersionRange = { min: 3, max: 4 }
    const s = await foreignServer((link) => link.send(encodeHello(theirs)))
    const a = client(mode(s))
    await waitFor(() => errors(a.events).length >= 2, 'a retry to fail too')
    for (const e of errors(a.events)) {
      expect(e.kind).toBe(kind)
      expect(e.error).toBeInstanceOf(ProtocolVersionError)
      expect((e.error as ProtocolVersionError).remote).toEqual(theirs)
      expect((e.error as ProtocolVersionError).local).toEqual(LOCAL_VERSIONS)
    }
    expect(a.events.some((e) => e.type === 'connected')).toBe(false)
    expect(a.provider.synced).toBe(false)
  })

  it('reports a server that answers with something other than a hello', async () => {
    const s = await foreignServer((link) =>
      link.send(encodeFrame('doc', MSG_SYNC, new Uint8Array([0, 1, 0]))),
    )
    const a = client(mode(s))
    await waitFor(() => errors(a.events).length > 0, 'the handshake to fail')
    const error = errors(a.events)[0]!.error as ProtocolVersionError
    expect(error).toBeInstanceOf(ProtocolVersionError)
    expect(error.remote).toBeNull()
  })

  it('reports a server that never answers the hello, as a server from before the handshake does', async () => {
    const s = await foreignServer(() => {})
    const a = client({ ...mode(s), connectTimeout: 300 })
    await waitFor(() => errors(a.events).length >= 2, 'a retry to time out too')
    for (const e of errors(a.events)) {
      expect(e.kind).toBe(kind)
      expect(e.error).toBeInstanceOf(ProtocolVersionError)
      expect((e.error as ProtocolVersionError).remote).toBeNull()
      expect((e.error as ProtocolVersionError).message).toMatch(/no version handshake/)
    }
    expect(a.events.some((e) => e.type === 'connected')).toBe(false)
  })
})

describe('auto mode', () => {
  it('does not fall back to WebSocket when the WebTransport server speaks another version', async () => {
    const s = await foreignServer((link) => link.send(encodeHello({ min: 9, max: 9 })))
    const a = client({ ...s })
    await waitFor(() => errors(a.events).length >= 2, 'two failed attempts')
    expect(a.events.some((e) => e.type === 'fallback')).toBe(false)
    expect(errors(a.events).every((e) => e.kind === 'webtransport')).toBe(true)
    expect(a.events.some((e) => e.type === 'connected')).toBe(false)
  })

  it('does not fall back to WebSocket when the WebTransport server never answers the hello', async () => {
    const s = await foreignServer(() => {})
    const a = client({ ...s, connectTimeout: 300 })
    await waitFor(() => errors(a.events).length >= 2, 'two failed attempts')
    expect(a.events.some((e) => e.type === 'fallback')).toBe(false)
    expect(errors(a.events).every((e) => e.kind === 'webtransport')).toBe(true)
  })
})

describe('server handshake', () => {
  async function raw(first: Uint8Array | null, options: SyncServerOptions = {}) {
    const s = await startServer(options, { webtransport: false })
    cleanup.push(() => s.stop())
    const ws = new WebSocket(s.wsUrl)
    ws.binaryType = 'arraybuffer'
    const received: Uint8Array[] = []
    let closed = false
    ws.on('message', (data: ArrayBuffer) => received.push(new Uint8Array(data)))
    ws.on('close', () => (closed = true))
    await new Promise((r) => ws.once('open', r))
    if (first) ws.send(first)
    cleanup.push(() => ws.terminate())
    return { s, received, isClosed: () => closed, send: (data: Uint8Array) => ws.send(data) }
  }

  it('answers a compatible hello with its own and then serves documents', async () => {
    const c = await raw(encodeHello({ min: 1, max: 5 }))
    await waitFor(() => c.received.length > 0, 'the server hello')
    expect(decodeHello(c.received[0]!)).toEqual(LOCAL_VERSIONS)
    expect(c.isClosed()).toBe(false)
  })

  it('answers an incompatible hello with its own versions and closes the connection', async () => {
    const c = await raw(encodeHello({ min: 3, max: 3 }))
    await waitFor(() => c.received.length > 0, 'the server hello')
    expect(decodeHello(c.received[0]!)).toEqual(LOCAL_VERSIONS)
    await waitFor(() => c.isClosed(), 'the server to close', 5000)
    expect(c.received).toHaveLength(1)
    expect(c.s.server.documents).toEqual([])
  })

  it('closes a connection whose first message is not a hello', async () => {
    const c = await raw(encodeFrame('doc', MSG_SYNC, new Uint8Array([0, 0])))
    await waitFor(() => c.isClosed(), 'the server to close')
    expect(c.received).toHaveLength(0)
    expect(c.s.server.documents).toEqual([])
  })

  it('closes a connection that never sends a hello', async () => {
    const c = await raw(null, { helloTimeout: 100 })
    await waitFor(() => c.isClosed(), 'the server to give up on the hello', 2000)
    expect(c.received).toHaveLength(0)
  })

  it('keeps serving a greeted connection past the hello timeout', async () => {
    const c = await raw(encodeHello(), { helloTimeout: 100 })
    await new Promise((r) => setTimeout(r, 300))
    // An answer proves the connection is still being served, not just that its close has not arrived yet.
    c.send(encodeFrame('doc', MSG_SYNC, new Uint8Array([0, 1, 0])))
    await waitFor(() => c.received.length > 1, 'the server to answer sync step 1')
    expect(c.isClosed()).toBe(false)
  })
})
