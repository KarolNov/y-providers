import { afterEach, describe, expect, it } from 'vitest'
import { Doc, applyUpdateV2, mergeUpdatesV2, text } from '#y'
import { SyncProvider, openTransport, type TransportOptions } from '#entry'
import { createFrameReader } from '../core/link.js'
import { startServer, waitFor, type TestServer } from './helpers.js'

let cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})
async function server() {
  const s = await startServer()
  cleanup.push(() => s.stop())
  return s
}
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
const dropAll = (s: TestServer) => {
  for (const link of (s.server as unknown as { links: Set<{ close(): void }> }).links) link.close()
}

describe('provider lifecycle and framing', () => {
  it('destroys an awareness it created', () => {
    const transport = openTransport({ mode: 'websocket', websocketUrl: 'ws://127.0.0.1:9' })
    const p = new SyncProvider('x', new Doc(), transport)
    let destroyed = false
    p.awareness!.on('destroy', () => (destroyed = true))
    p.destroy()
    transport.close()
    expect(destroyed).toBe(true)
  })

  it('presence comes back right after a reconnect', async () => {
    const s = await server()
    const a = client({ mode: 'websocket', websocketUrl: s.wsUrl, minBackoff: 10, maxBackoff: 20 })
    const b = client({ mode: 'websocket', websocketUrl: s.wsUrl, minBackoff: 10, maxBackoff: 20 })
    a.provider.awareness!.setLocalState({ name: 'ann' })
    b.provider.awareness!.setLocalState({ name: 'bob' })
    await waitFor(
      () =>
        b.provider.awareness!.getStates().has(a.doc.clientID) &&
        a.provider.awareness!.getStates().has(b.doc.clientID),
    )
    let reconnects = 0
    a.transport.subscribe((e) => e.type === 'connected' && reconnects++)
    b.transport.subscribe((e) => e.type === 'connected' && reconnects++)
    dropAll(s)
    await waitFor(() => reconnects === 2, 'both to reconnect')
    await waitFor(
      () => b.provider.awareness!.getStates().get(a.doc.clientID)?.name === 'ann',
      'ann back at bob',
      3000,
    )
    await waitFor(
      () => a.provider.awareness!.getStates().get(b.doc.clientID)?.name === 'bob',
      'bob back at ann',
      3000,
    )
  })

  it('re-attaching a document on a live connection sends edits made while detached', async () => {
    const s = await server()
    const transport = openTransport({ mode: 'websocket', websocketUrl: s.wsUrl })
    cleanup.push(() => transport.close())
    const doc = new Doc()
    const first = new SyncProvider('doc', doc, transport)
    await first.whenSynced
    first.destroy()
    text(doc, 't').insert(0, 'while detached')
    const second = new SyncProvider('doc', doc, transport)
    cleanup.push(() => second.destroy())
    await second.whenSynced
    const other = client({ mode: 'websocket', websocketUrl: s.wsUrl })
    await waitFor(
      () => text(other.doc, 't').toString() === 'while detached',
      'edit to arrive',
      3000,
    )
  })

  it('reassembles a large frame from small chunks in linear time', () => {
    const size = 8 * 1024 * 1024
    const frame = new Uint8Array(size + 4)
    frame.set([0x80, 0x80, 0x80 | 0x00, 0x04]) // varuint 8 MiB = 0x800000 -> 0x80 0x80 0x80 0x04
    let got = 0
    const read = createFrameReader((f) => (got = f.length))
    const start = performance.now()
    for (let i = 0; i < frame.length; i += 1200) read(frame.subarray(i, i + 1200))
    expect(got).toBe(size)
    expect(performance.now() - start).toBeLessThan(2000)
  })
})
