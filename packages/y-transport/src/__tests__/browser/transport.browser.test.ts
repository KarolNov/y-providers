// Runs in real Chromium, Firefox and WebKit with their native WebTransport and
// WebSocket, against the Node server started by ./server.ts.
import { afterEach, describe, expect, inject, it, test } from 'vitest'
import { commands, server as page } from 'vitest/browser'
import { Doc, applyUpdateV2, mergeUpdatesV2, text } from '#y'
import {
  SyncProvider,
  openTransport,
  webTransportSupported,
  type TransportEvent,
  type TransportOptions,
} from '#entry'

const server = inject('transportServer')
const webTransport: TransportOptions = {
  webTransportUrl: server.webTransportUrl,
  webTransportOptions: {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(server.certHash) }],
  },
}
const optionsFor = {
  webtransport: { mode: 'webtransport', ...webTransport },
  websocket: { mode: 'websocket', websocketUrl: server.wsUrl },
} satisfies Record<string, TransportOptions>

// One server is shared by every test, so each test gets its own documents.
let uid = 0
const docName = () => `doc-${Date.now()}-${uid++}`

async function waitFor(condition: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

let cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

function client(options: TransportOptions, name: string) {
  const transport = openTransport(options)
  const events: TransportEvent[] = []
  transport.subscribe((e) => events.push(e))
  const doc = new Doc()
  const provider = new SyncProvider(name, doc, transport)
  cleanup.push(() => {
    provider.destroy()
    transport.close()
  })
  return { transport, events, doc, provider }
}

// Playwright's WebKit has no WebTransport (checked with WebKit 26.6). If that
// changes, the first test fails and the WebTransport tests should be enabled.
const webTransportExpected = page.browser !== 'webkit'

it(`has native WebSocket and ${webTransportExpected ? '' : 'no '}WebTransport in ${page.browser}`, () => {
  expect(typeof WebSocket).toBe('function')
  expect(webTransportSupported()).toBe(webTransportExpected)
})

/** Tests that need WebTransport; reported as skipped where the browser has none. */
const withWebTransport = it.runIf(webTransportExpected)

withWebTransport(
  'rejects the self-signed certificate when a different hash is pinned',
  async () => {
    const wrong = new Uint8Array(server.certHash).map((byte) => byte ^ 0xff)
    const a = client(
      {
        mode: 'webtransport',
        webTransportUrl: server.webTransportUrl,
        webTransportOptions: { serverCertificateHashes: [{ algorithm: 'sha-256', value: wrong }] },
        connectTimeout: 2000,
      },
      docName(),
    )
    await waitFor(() => a.events.some((e) => e.type === 'error'), 'the handshake to fail')
    expect(a.events.some((e) => e.type === 'connected')).toBe(false)
  },
)

/**
 * The browser's WebTransport, counting the datagrams a client sends and
 * receives, so a test can tell what travelled as a datagram.
 */
function countingWebTransport() {
  const counts = { sent: 0, received: 0 }
  class CountingWebTransport extends WebTransport {
    #datagrams?: WebTransportDatagramDuplexStream
    override get datagrams() {
      if (this.#datagrams) return this.#datagrams
      const real = super.datagrams
      let writer: WritableStreamDefaultWriter<Uint8Array> | undefined
      const datagrams = {
        readable: real.readable.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              counts.received++
              controller.enqueue(chunk)
            },
          }),
        ),
        writable: new WritableStream<Uint8Array>({
          write(chunk) {
            writer ??= (
              (real as { createWritable?(): WritableStream<Uint8Array> }).createWritable?.() ??
              real.writable
            ).getWriter()
            counts.sent++
            return writer.write(chunk)
          },
        }),
        get maxDatagramSize() {
          return real.maxDatagramSize
        },
      }
      return (this.#datagrams = datagrams as unknown as WebTransportDatagramDuplexStream)
    }
  }
  return { counts, WebTransport: CountingWebTransport as TransportOptions['WebTransport'] }
}

withWebTransport('sends awareness renewals as datagrams, client to server to client', async () => {
  const name = docName()
  const ca = countingWebTransport()
  const cb = countingWebTransport()
  const a = client({ ...optionsFor.webtransport, WebTransport: ca.WebTransport }, name)
  const b = client({ ...optionsFor.webtransport, WebTransport: cb.WebTransport }, name)
  await a.provider.whenSynced
  await b.provider.whenSynced
  // The first state on a connection is sent reliably.
  a.provider.awareness!.setLocalState({ name: 'ann', cursor: 0 })
  await waitFor(
    () => b.provider.awareness!.getStates().get(a.doc.clientID)?.cursor === 0,
    'first state to arrive',
  )
  const sent = ca.counts.sent
  const received = cb.counts.received
  // Renewals go as datagrams: a sends them, the server forwards them as datagrams to b.
  a.provider.awareness!.setLocalState({ name: 'ann', cursor: 1 })
  await waitFor(
    () => b.provider.awareness!.getStates().get(a.doc.clientID)?.cursor === 1,
    'renewal to arrive',
  )
  expect(ca.counts.sent).toBeGreaterThan(sent)
  expect(cb.counts.received).toBeGreaterThan(received)
  expect(a.transport.kind).toBe('webtransport')
})

describe.each(['webtransport', 'websocket'] as const)('over %s', (kind) => {
  const options: TransportOptions = optionsFor[kind]
  const it = kind === 'webtransport' ? withWebTransport : test

  it('syncs a document between two clients in both directions', async () => {
    const name = docName()
    const a = client(options, name)
    const b = client(options, name)
    text(a.doc, 't').insert(0, 'hello')
    await a.provider.whenSynced
    await b.provider.whenSynced
    await waitFor(() => text(b.doc, 't').toString() === 'hello', 'b to get hello')
    text(b.doc, 't').insert(5, ' world')
    await waitFor(() => text(a.doc, 't').toString() === 'hello world', 'a to get world')
    expect(a.transport.kind).toBe(kind)
    expect(b.transport.kind).toBe(kind)
  })

  it('shares awareness and removes it when a client leaves', async () => {
    const name = docName()
    const a = client(options, name)
    const b = client(options, name)
    a.provider.awareness!.setLocalState({ name: 'ann' })
    await waitFor(
      () => b.provider.awareness!.getStates().get(a.doc.clientID)?.name === 'ann',
      'presence to arrive',
    )
    // A renewal after the first state may travel as a datagram on WebTransport.
    a.provider.awareness!.setLocalState({ name: 'ann', cursor: 3 })
    await waitFor(
      () => b.provider.awareness!.getStates().get(a.doc.clientID)?.cursor === 3,
      'presence update to arrive',
    )
    expect(a.transport.kind).toBe(kind)
    a.provider.destroy()
    await waitFor(() => !b.provider.awareness!.getStates().has(a.doc.clientID), 'presence to go')
  })

  it('reconnects after the server drops the connection and merges offline edits', async () => {
    const name = docName()
    const a = client({ ...options, minBackoff: 20, maxBackoff: 50 }, name)
    const b = client({ ...options, minBackoff: 20, maxBackoff: 50 }, name)
    await a.provider.whenSynced
    await b.provider.whenSynced
    expect(await commands.dropConnections()).toBeGreaterThanOrEqual(2)
    await waitFor(() => a.events.some((e) => e.type === 'disconnected'), 'a to notice')
    text(a.doc, 't').insert(0, 'offline')
    await waitFor(
      () => a.events.filter((e) => e.type === 'connected').length === 2,
      'a to reconnect',
    )
    await waitFor(() => text(b.doc, 't').toString() === 'offline', 'offline edit to reach b')
    expect(a.transport.kind).toBe(kind)
    expect(
      a.events.filter((e) => e.type === 'connected').every((e) => 'kind' in e && e.kind === kind),
    ).toBe(true)
  })
})

describe("mode 'auto'", () => {
  withWebTransport('picks WebTransport when the server is reachable', async () => {
    const name = docName()
    const a = client({ websocketUrl: server.wsUrl, ...webTransport }, name)
    const b = client({ mode: 'websocket', websocketUrl: server.wsUrl }, name)
    text(a.doc, 't').insert(0, 'auto')
    await a.provider.whenSynced
    expect(a.transport.kind).toBe('webtransport')
    expect(a.events.some((e) => e.type === 'fallback')).toBe(false)
    // And a WebTransport client syncs with a WebSocket one through the same server.
    await waitFor(() => text(b.doc, 't').toString() === 'auto', 'b to get the edit')
  })

  withWebTransport(
    'falls back to WebSocket when the WebTransport endpoint is unreachable',
    async () => {
      const name = docName()
      const a = client(
        {
          websocketUrl: server.wsUrl,
          ...webTransport,
          webTransportUrl: 'https://127.0.0.1:9/sync', // nothing listens there
          connectTimeout: 2000,
        },
        name,
      )
      const b = client(optionsFor.webtransport, name)
      text(a.doc, 't').insert(0, 'fell back')
      await a.provider.whenSynced
      expect(a.transport.kind).toBe('websocket')
      const fallback = a.events.find((e) => e.type === 'fallback')
      expect(fallback).toMatchObject({ from: 'webtransport', to: 'websocket' })
      await waitFor(() => text(b.doc, 't').toString() === 'fell back', 'b to get the edit')
    },
  )

  it.runIf(!webTransportExpected)(
    'uses WebSocket without trying WebTransport where the browser has none',
    async () => {
      const name = docName()
      const a = client({ websocketUrl: server.wsUrl, ...webTransport }, name)
      const b = client(optionsFor.websocket, name)
      text(a.doc, 't').insert(0, 'no wt')
      await a.provider.whenSynced
      expect(a.transport.kind).toBe('websocket')
      expect(a.events.some((e) => e.type === 'fallback')).toBe(false)
      await waitFor(() => text(b.doc, 't').toString() === 'no wt', 'b to get the edit')
    },
  )
})
