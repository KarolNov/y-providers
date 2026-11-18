// A v13 client and a v14 client on one server. Not promised in 0.1.0: these
// tests record what works and what does not, on a server of either major.
// They import both majors directly and don't depend on the `#entry` aliases,
// so only the node-v13 project runs them (see vitest.config.ts).
import { afterEach, describe, expect, it } from 'vitest'
import * as Y13 from 'yjs'
import * as Y14 from '@y/y'
import { MemoryDocumentStore as Store13 } from 'y-append-log'
import { MemoryDocumentStore as Store14 } from 'y-append-log/y14'
import * as v13 from '../index.js'
import * as v14 from '../y14.js'
import { SyncServer as Server13 } from '../server/index.js'
import { SyncServer as Server14 } from '../server/y14.js'
import type { SyncServerOptions } from '../core/server/index.js'
import { startServerWith, waitFor, type ServerClass, type TestServer } from './harness.js'

let cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

async function server(Server: ServerClass, options: SyncServerOptions = {}) {
  const s = await startServerWith(Server, options, { webtransport: false })
  cleanup.push(() => s.stop())
  return s
}

type Entry = typeof v13 | typeof v14

/** A client of one major on `doc`: `client(v13, new Y13.Doc(), s)` or `client(v14, new Y14.Doc(), s)`. */
function client<E extends Entry, D extends Y13.Doc | Y14.Doc>(
  entry: E,
  doc: D,
  s: TestServer,
  name = 'doc',
) {
  const transport = entry.openTransport({
    mode: 'websocket',
    websocketUrl: s.wsUrl,
  })
  const provider = new (entry.SyncProvider as new (
    ...args: unknown[]
  ) => InstanceType<E['SyncProvider']>)(name, doc, transport)
  const close = () => {
    provider.destroy()
    transport.close()
  }
  cleanup.push(close)
  return { doc, provider, close }
}

const client13 = (s: TestServer, name?: string) => client(v13, new Y13.Doc(), s, name)
const client14 = (s: TestServer, name?: string) => client(v14, new Y14.Doc(), s, name)

/** Text `t` as `[{ insert, attributes? }]` runs, the same shape for both majors. */
type Run = { insert: unknown; attributes?: Record<string, unknown> }
const runs13 = (doc: Y13.Doc) => JSON.stringify(doc.getText('t').toDelta() as Run[])
const runs14 = (doc: Y14.Doc) =>
  JSON.stringify(
    (
      (
        doc.get('t').toDelta() as unknown as {
          toJSON(): {
            children?: Array<{ insert: unknown; format?: Run['attributes'] }>
          }
        }
      ).toJSON().children ?? []
    ).map(({ insert, format }): Run => (format ? { insert, attributes: format } : { insert })),
  )

describe.each([
  ['a v13 server', Server13, () => new Store13()],
  ['a v14 server', Server14, () => new Store14()],
] as const)('v13 and v14 clients through %s', (_, Server, store) => {
  it('sync root text and map both ways', async () => {
    const s = await server(Server)
    const a = client13(s)
    const b = client14(s)
    await a.provider.whenSynced
    await b.provider.whenSynced

    a.doc.getText('t').insert(0, 'from v13')
    a.doc.getMap('m').set('who', 'v13')
    await waitFor(
      () => b.doc.get('t').toString() === 'from v13' && b.doc.get('m').getAttr('who') === 'v13',
      'v14 to get the text and the map',
    )

    b.doc.get('t').insert(0, 'v14 + ')
    b.doc.get('m').setAttr('also', 'v14')
    await waitFor(
      () =>
        a.doc.getText('t').toString() === 'v14 + from v13' &&
        JSON.stringify(a.doc.getMap('m').toJSON()) === JSON.stringify({ who: 'v13', also: 'v14' }),
      'v13 to get the text and the map',
    )
  })

  it('sync a root list both ways', async () => {
    const s = await server(Server)
    const a = client13(s)
    const b = client14(s)
    await a.provider.whenSynced
    await b.provider.whenSynced
    a.doc.getArray('l').insert(0, [1, 'a', { k: true }])
    await waitFor(
      () => JSON.stringify(b.doc.get('l').toJSON().children) === '[1,"a",{"k":true}]',
      'v14 to get the list',
    )
    b.doc.get('l').insert(3, ['from v14'])
    await waitFor(
      () => JSON.stringify(a.doc.getArray('l').toArray()) === '[1,"a",{"k":true},"from v14"]',
      'v13 to get the v14 item',
    )
  })

  it('keep formatting and concurrent edits convergent, both ways', async () => {
    const s = await server(Server)
    const a = client13(s)
    const b = client14(s)
    await a.provider.whenSynced
    await b.provider.whenSynced
    a.doc.getText('t').insert(0, 'bold plain')
    await waitFor(() => b.doc.get('t').toString() === 'bold plain', 'v14 to get the text')
    b.doc.get('t').format(0, 4, { bold: true })
    a.doc.getText('t').insert(10, '!')
    a.doc.getText('t').format(5, 5, { italic: true })
    const expected = JSON.stringify([
      { insert: 'bold', attributes: { bold: true } },
      { insert: ' ' },
      { insert: 'plain', attributes: { italic: true } },
      { insert: '!' },
    ])
    await waitFor(() => runs13(a.doc) === expected, 'v13 to get the v14 formatting')
    await waitFor(() => runs14(b.doc) === expected, 'v14 to get the v13 formatting')
  })

  it('share awareness', async () => {
    const s = await server(Server)
    const a = client13(s)
    // v14 client IDs are 53-bit, v13 ones 32-bit: pin one above 2^32 so the large-ID path always runs.
    const doc14 = new Y14.Doc()
    doc14.clientID = 2 ** 40 + 7
    const b = client(v14, doc14, s)
    await a.provider.whenSynced
    await b.provider.whenSynced
    a.provider.awareness!.setLocalStateField('name', 'v13')
    b.provider.awareness!.setLocalStateField('name', 'v14')
    await waitFor(
      () => a.provider.awareness!.getStates().get(2 ** 40 + 7)?.name === 'v14',
      'v13 to see v14',
    )
    await waitFor(
      () => b.provider.awareness!.getStates().get(a.doc.clientID)?.name === 'v13',
      'v14 to see v13',
    )
  })

  it('carry a nested map made by a v13 client to v14 and back', async () => {
    const s = await server(Server)
    const a = client13(s)
    const b = client14(s)
    await a.provider.whenSynced
    await b.provider.whenSynced
    const card = new Y13.Map<string>()
    a.doc.getMap('cards').set('c1', card)
    card.set('title', 'v13 card')
    await waitFor(
      () => b.doc.get('cards').getAttr('c1')?.getAttr('title') === 'v13 card',
      'v14 to get the card',
    )
    b.doc.get('cards').getAttr('c1').setAttr('done', 'yes')
    await waitFor(() => card.get('done') === 'yes', 'v13 to get the v14 edit')
    // v14 remembers the node came in as a Y.Map, so it is still one in v13.
    expect(a.doc.getMap('cards').get('c1')).toBeInstanceOf(Y13.Map)
  })

  it('known gap: a nested node made by a v14 client reaches v13 as an XML type, not a Y.Map', async () => {
    const s = await server(Server)
    const a = client13(s)
    const b = client14(s)
    await a.provider.whenSynced
    await b.provider.whenSynced
    const card = new Y14.Node()
    b.doc.get('cards').setAttr('c1', card)
    b.doc.get('cards').setAttr('c2', new Y14.Node('card'))
    card.setAttr('title', 'v14 card')
    await waitFor(
      () => a.doc.getMap('cards').has('c1') && a.doc.getMap('cards').has('c2'),
      'v13 to get the cards',
    )
    // v14 has one node type and labels nested nodes as XML when it encodes them:
    // an unnamed node as a Y.XmlFragment, a named one as a Y.XmlElement.
    expect(a.doc.getMap('cards').get('c1')?.constructor).toBe(Y13.XmlFragment)
    const named = a.doc.getMap('cards').get('c2')
    expect(named?.constructor).toBe(Y13.XmlElement)
    expect((named as Y13.XmlElement).nodeName).toBe('card')
    // The data is not lost: a v14 client joining later through the same server still reads it.
    const c = client14(s)
    await c.provider.whenSynced
    await waitFor(
      () => c.doc.get('cards').getAttr('c1')?.getAttr('title') === 'v14 card',
      'a late v14 client to read it',
    )
  })

  it('keep both majors’ nested types through storage and a reload', async () => {
    const storage = store()
    const s = await server(Server, { storage, evictAfter: 10 })
    const a = client13(s)
    const b = client14(s)
    await a.provider.whenSynced
    await b.provider.whenSynced
    const map13 = new Y13.Map<string>()
    a.doc.getMap('cards').set('m13', map13)
    map13.set('title', 'v13 card')
    const node14 = new Y14.Node()
    b.doc.get('cards').setAttr('n14', node14)
    node14.setAttr('title', 'v14 card')
    await waitFor(
      () =>
        a.doc.getMap('cards').has('n14') &&
        b.doc.get('cards').getAttr('m13')?.getAttr('title') === 'v13 card',
      'both cards to cross',
    )
    a.close()
    b.close()
    await waitFor(() => s.server.documents.length === 0, 'the room to be evicted')

    const c13 = client13(s)
    const c14 = client14(s)
    await waitFor(
      () =>
        (c13.doc.getMap('cards').get('m13') as Y13.Map<string> | undefined)?.get('title') ===
          'v13 card' && c13.doc.getMap('cards').has('n14'),
      'a late v13 client to read the stored cards',
    )
    expect(c13.doc.getMap('cards').get('m13')?.constructor).toBe(Y13.Map)
    expect(c13.doc.getMap('cards').get('n14')?.constructor).toBe(Y13.XmlFragment)
    await waitFor(
      () =>
        c14.doc.get('cards').getAttr('m13')?.getAttr('title') === 'v13 card' &&
        c14.doc.get('cards').getAttr('n14')?.getAttr('title') === 'v14 card',
      'a late v14 client to read the stored cards',
    )
  })

  it('workaround, private API: a v14 node labelled as a Y.Map before it is inserted reaches v13 as one', async () => {
    // `_legacyTypeRef` is private to @y/y and may change in any release candidate.
    // This test pins today's behavior so the CI job on @y/y@beta notices a change.
    const s = await server(Server)
    const a = client13(s)
    const b = client14(s)
    await a.provider.whenSynced
    await b.provider.whenSynced
    const card = new Y14.Node() as Y14.Node & { _legacyTypeRef: number }
    card._legacyTypeRef = 1 // YMapRefID
    b.doc.get('cards').setAttr('c1', card)
    card.setAttr('title', 'v14 card')
    await waitFor(() => {
      const seen = a.doc.getMap('cards').get('c1')
      return seen instanceof Y13.Map && seen.get('title') === 'v14 card'
    }, 'v13 to read a Y.Map')
    expect(a.doc.getMap('cards').get('c1')).toBeInstanceOf(Y13.Map)
  })
})
