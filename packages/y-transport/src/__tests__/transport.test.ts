import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { Doc, applyUpdateV2, mergeUpdatesV2, text } from '#y'
import {
  SyncProvider,
  openTransport,
  type Transport,
  type TransportEvent,
  type TransportOptions,
} from '#entry'
import { MemoryDocumentStore } from '#log'
import { startServer, waitFor, type TestServer } from './helpers.js'

let cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

function client(options: TransportOptions, name = 'doc') {
  const transport = openTransport(options)
  const doc = new Doc()
  const provider = new SyncProvider(name, doc, transport)
  cleanup.push(() => {
    provider.destroy()
    transport.close()
  })
  return { transport, doc, provider }
}

async function server(options?: Parameters<typeof startServer>[0]) {
  const s = await startServer(options)
  cleanup.push(() => s.stop())
  return s
}

const modes = (s: TestServer) =>
  [
    ['websocket', { mode: 'websocket', websocketUrl: s.wsUrl }],
    ['webtransport', { mode: 'webtransport', ...s.wtOptions }],
  ] as const

describe.each(['websocket', 'webtransport'] as const)('sync over %s', (kind) => {
  const opts = (s: TestServer): TransportOptions =>
    modes(s).find(([k]) => k === kind)![1] as TransportOptions

  it('syncs two clients in both directions and reports the protocol in use', async () => {
    const s = await server()
    const a = client(opts(s))
    const b = client(opts(s))
    text(a.doc, 't').insert(0, 'hello')
    await a.provider.whenSynced
    await b.provider.whenSynced
    await waitFor(() => text(b.doc, 't').toString() === 'hello', 'b to get hello')
    text(b.doc, 't').insert(5, ' world')
    await waitFor(() => text(a.doc, 't').toString() === 'hello world', 'a to get world')
    expect(a.transport.kind).toBe(kind)
    expect(a.transport.status).toBe('connected')
  })

  it('shares presence and removes it when a client leaves', async () => {
    const s = await server()
    const a = client(opts(s))
    const b = client(opts(s))
    a.provider.awareness!.setLocalState({ name: 'ann' })
    await waitFor(
      () => b.provider.awareness!.getStates().get(a.doc.clientID)?.name === 'ann',
      'presence to arrive',
    )
    a.provider.destroy()
    await waitFor(() => !b.provider.awareness!.getStates().has(a.doc.clientID), 'presence to go')
  })

  it('carries several documents over one connection', async () => {
    const s = await server()
    const transport = openTransport(opts(s))
    cleanup.push(() => transport.close())
    const other = client(opts(s), 'one')
    const one = new Doc()
    const two = new Doc()
    new SyncProvider('one', one, transport)
    const p2 = new SyncProvider('two', two, transport)
    text(one, 't').insert(0, '1')
    text(two, 't').insert(0, '2')
    await p2.whenSynced
    await waitFor(() => text(other.doc, 't').toString() === '1', 'doc one to arrive')
    const third = client(opts(s), 'two')
    await waitFor(() => text(third.doc, 't').toString() === '2', 'doc two to arrive')
    expect(text(other.doc, 't').toString()).toBe('1')
  })

  it('reconnects after the server drops the connection and merges offline edits', async () => {
    const s = await server()
    const events: TransportEvent[] = []
    const a = client({ ...opts(s), minBackoff: 20, maxBackoff: 50 })
    a.transport.subscribe((e) => events.push(e))
    const b = client(opts(s))
    await a.provider.whenSynced
    // Kill a's connection from the server side.
    for (const link of (s.server as unknown as { links: Set<{ close(): void }> }).links)
      link.close()
    await waitFor(() => events.some((e) => e.type === 'disconnected'), 'a to notice')
    text(a.doc, 't').insert(0, 'offline')
    await waitFor(() => a.transport.status === 'connected', 'a to reconnect')
    await waitFor(() => text(b.doc, 't').toString() === 'offline', 'offline edit to reach b')
  })

  it('does not let a denied connection into a document', async () => {
    const s = await server({ authorize: (doc) => doc !== 'secret' })
    const a = client(opts(s), 'secret')
    const b = client(opts(s), 'secret')
    text(a.doc, 't').insert(0, 'nope')
    const open = client(opts(s), 'open')
    text(open.doc, 't').insert(0, 'yes')
    const other = client(opts(s), 'open')
    await waitFor(() => text(other.doc, 't').toString() === 'yes', 'open doc to sync')
    expect(text(b.doc, 't').toString()).toBe('')
    expect(s.server.documents).not.toContain('secret')
  })
})

describe('server storage', () => {
  it('persists documents and serves them after eviction', async () => {
    const storage = new MemoryDocumentStore()
    const s = await server({ storage, evictAfter: 10 })
    const a = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    text(a.doc, 't').insert(0, 'kept')
    await a.provider.whenSynced
    await waitFor(() => storage.docs.has('doc'), 'storage to be written')
    a.provider.destroy()
    a.transport.close()
    await waitFor(() => s.server.documents.length === 0, 'room to be evicted')
    const b = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    await waitFor(() => text(b.doc, 't').toString() === 'kept', 'stored doc to load')
  })

  // Three stored updates, the last deleting part of the first: all of them have to arrive.
  function storedUpdates() {
    const doc = new Doc()
    const updates: Uint8Array[] = []
    doc.on('updateV2', (u: Uint8Array) => updates.push(u))
    const t = text(doc, 't')
    t.insert(0, 'hello')
    t.insert(5, ' world')
    t.delete(0, 1)
    return updates
  }

  it('loads every stored update, in one transaction, and does not write them back', async () => {
    const updates = storedUpdates()
    const appended: Uint8Array[] = []
    const s = await server({
      storage: {
        load: async (name) => (name === 'doc' ? updates : null),
        append: async (_, update) => void appended.push(update),
        delete: async () => {},
      },
    })
    const a = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    await a.provider.whenSynced
    expect(text(a.doc, 't').toString()).toBe('ello world')
    expect(appended).toEqual([])
  })

  // Fails `instanceof Uint8Array`, as bytes read under Jest's sandbox do.
  it('loads updates made in another realm', async () => {
    const merged = mergeUpdatesV2(storedUpdates())
    const bytes: Uint8Array = runInNewContext('new Uint8Array(length)', { length: merged.length })
    bytes.set(merged)
    const s = await server({
      storage: { load: async () => [bytes], append: async () => {}, delete: async () => {} },
    })
    const a = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    await a.provider.whenSynced
    expect(text(a.doc, 't').toString()).toBe('ello world')
  })

  it('appends accepted updates to the store', async () => {
    const storage = new MemoryDocumentStore()
    const s = await server({ storage })
    const a = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    text(a.doc, 't').insert(0, 'appended')
    await a.provider.whenSynced
    await waitFor(() => storage.docs.has('doc'), 'append to land')
    const doc = new Doc()
    for (const u of (await storage.load('doc'))!) applyUpdateV2(doc, u)
    expect(text(doc, 't').toString()).toBe('appended')
  })
})

describe('eviction without storage', () => {
  it('keeps documents by default', async () => {
    const s = await server()
    const a = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    text(a.doc, 't').insert(0, 'only copy')
    await a.provider.whenSynced
    a.provider.destroy()
    a.transport.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(s.server.documents).toEqual(['doc'])
    const b = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    await waitFor(() => text(b.doc, 't').toString() === 'only copy', 'kept doc to sync')
  })

  it('frees an idle document after evictAfter, and only once every connection has left', async () => {
    const s = await server({ evictAfter: 10 })
    const a = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    const b = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    text(a.doc, 't').insert(0, 'shared')
    await waitFor(() => text(b.doc, 't').toString() === 'shared', 'b to sync')
    a.provider.destroy()
    a.transport.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(s.server.documents).toEqual(['doc'])
    b.provider.destroy()
    b.transport.close()
    await waitFor(() => s.server.documents.length === 0, 'room to be evicted')
    // The server's copy is gone: a new client gets an empty document.
    const c = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    await c.provider.whenSynced
    expect(text(c.doc, 't').toString()).toBe('')
  })

  it('rebuilds an evicted document from a client that still holds it', async () => {
    const s = await server({ evictAfter: 10 })
    const a = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    text(a.doc, 't').insert(0, 'from a client')
    await a.provider.whenSynced
    a.provider.destroy()
    await waitFor(() => s.server.documents.length === 0, 'room to be evicted')
    // The same doc, attached again: the state exchange sends the server what it lacks.
    const again = new SyncProvider('doc', a.doc, a.transport)
    cleanup.push(() => again.destroy())
    const b = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    await waitFor(() => text(b.doc, 't').toString() === 'from a client', 'doc to come back')
  })
})

describe('mode selection', () => {
  it('auto uses WebTransport when it is available', async () => {
    const s = await server()
    const a = client({ websocketUrl: s.wsUrl, ...s.wtOptions })
    await a.provider.whenSynced
    expect(a.transport.kind).toBe('webtransport')
  })

  it('auto falls back to WebSocket when WebTransport cannot connect, and remembers', async () => {
    const s = await server()
    const events: TransportEvent[] = []
    const a = client({
      websocketUrl: s.wsUrl,
      ...s.wtOptions,
      webTransportUrl: 'https://127.0.0.1:9/sync', // nothing listens there
      connectTimeout: 500,
      minBackoff: 20,
      maxBackoff: 50,
    })
    a.transport.subscribe((e) => events.push(e))
    await a.provider.whenSynced
    expect(a.transport.kind).toBe('websocket')
    expect(events.find((e) => e.type === 'fallback')).toBeTruthy()
    // After a drop it goes straight to WebSocket instead of waiting for WebTransport to time out again.
    const before = events.filter((e) => e.type === 'fallback').length
    for (const link of (s.server as unknown as { links: Set<{ close(): void }> }).links)
      link.close()
    await waitFor(() => events.filter((e) => e.type === 'connected').length === 2, 'reconnect')
    expect(events.filter((e) => e.type === 'fallback').length).toBe(before)
  })

  it('auto uses WebSocket when there is no WebTransport URL or support', async () => {
    const s = await server()
    const a = client({
      websocketUrl: s.wsUrl,
      webTransportUrl: s.wtOptions.webTransportUrl,
      WebTransport: undefined,
    })
    // Node has no global WebTransport, so nothing to try.
    await a.provider.whenSynced
    expect(a.transport.kind).toBe('websocket')
  })

  it('rejects impossible configurations up front', () => {
    expect(() => openTransport({ mode: 'websocket' })).toThrow(/websocketUrl/)
    expect(() => openTransport({ mode: 'webtransport', webTransportUrl: 'https://x' })).toThrow(
      /not supported/,
    )
    expect(() => openTransport({ mode: 'webtransport' })).toThrow(/webTransportUrl/)
    expect(() => openTransport({})).toThrow(/No usable endpoint/)
    expect(() => openTransport({ mode: 'socketio' as never })).toThrow(/Unknown transport mode/)
  })
})
