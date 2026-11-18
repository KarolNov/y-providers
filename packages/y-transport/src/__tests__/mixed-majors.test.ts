// A v13 client and a v14 client on one server. Not promised in 0.1.0: these
// tests record what works and what does not, on a server of either major.
// They import both majors directly, so they don't depend on the `#entry`
// aliases and run the same in both Node projects.
import { afterEach, describe, expect, it } from 'vitest'
import * as Y13 from 'yjs'
import * as Y14 from '@y/y'
import * as v13 from '../index.js'
import * as v14 from '../y14.js'
import { SyncServer as Server13 } from '../server/index.js'
import { SyncServer as Server14 } from '../server/y14.js'
import { startServerWith, waitFor, type ServerClass, type TestServer } from './harness.js'

let cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

async function server(Server: ServerClass) {
  const s = await startServerWith(Server, {}, { webtransport: false })
  cleanup.push(() => s.stop())
  return s
}

function client13(s: TestServer, name = 'doc') {
  const transport = v13.openTransport({ mode: 'websocket', websocketUrl: s.wsUrl })
  const doc = new Y13.Doc()
  const provider = new v13.SyncProvider(name, doc, transport)
  cleanup.push(() => {
    provider.destroy()
    transport.close()
  })
  return { doc, provider }
}

function client14(s: TestServer, name = 'doc') {
  const transport = v14.openTransport({ mode: 'websocket', websocketUrl: s.wsUrl })
  const doc = new Y14.Doc()
  const provider = new v14.SyncProvider(name, doc, transport)
  cleanup.push(() => {
    provider.destroy()
    transport.close()
  })
  return { doc, provider }
}

describe.each([
  ['a v13 server', Server13],
  ['a v14 server', Server14],
] as const)('v13 and v14 clients through %s', (_, Server) => {
  it('sync root text and map both ways', async () => {
    const s = await server(Server)
    const a = client13(s)
    const b = client14(s)
    await a.provider.whenSynced
    await b.provider.whenSynced

    a.doc.getText('t').insert(0, 'from v13')
    a.doc.getMap('m').set('who', 'v13')
    await waitFor(() => b.doc.get('t').toString() === 'from v13', 'v14 to get the text')
    expect(b.doc.get('m').getAttr('who')).toBe('v13')

    b.doc.get('t').insert(0, 'v14 + ')
    b.doc.get('m').setAttr('also', 'v14')
    await waitFor(() => a.doc.getText('t').toString() === 'v14 + from v13', 'v13 to get the text')
    expect(a.doc.getMap('m').toJSON()).toEqual({ who: 'v13', also: 'v14' })
  })

  it('keep formatting and concurrent edits convergent', async () => {
    const s = await server(Server)
    const a = client13(s)
    const b = client14(s)
    await a.provider.whenSynced
    await b.provider.whenSynced
    a.doc.getText('t').insert(0, 'bold plain')
    await waitFor(() => b.doc.get('t').toString() === 'bold plain', 'v14 to get the text')
    b.doc.get('t').format(0, 4, { bold: true })
    a.doc.getText('t').insert(10, '!')
    await waitFor(
      () =>
        a.doc.getText('t').toString() === 'bold plain!' &&
        b.doc.get('t').toString() === 'bold plain!',
      'both to converge',
    )
    await waitFor(
      () =>
        JSON.stringify(a.doc.getText('t').toDelta()[0]) ===
        '{"insert":"bold","attributes":{"bold":true}}',
      'v13 to get the formatting',
    )
  })

  it('share awareness', async () => {
    const s = await server(Server)
    const a = client13(s)
    const b = client14(s)
    await a.provider.whenSynced
    await b.provider.whenSynced
    a.provider.awareness!.setLocalStateField('name', 'v13')
    b.provider.awareness!.setLocalStateField('name', 'v14')
    await waitFor(
      () => a.provider.awareness!.getStates().get(b.doc.clientID)?.name === 'v14',
      'v13 to see v14',
    )
    await waitFor(
      () => b.provider.awareness!.getStates().get(a.doc.clientID)?.name === 'v13',
      'v14 to see v13',
    )
    // v14 client IDs are 53-bit, v13 ones 32-bit; both survive the trip.
    expect(b.doc.clientID).toBeGreaterThan(2 ** 32)
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
    card.setAttr('title', 'v14 card')
    await waitFor(() => a.doc.getMap('cards').has('c1'), 'v13 to get the card')
    const seen = a.doc.getMap('cards').get('c1')
    // v14 has one node type and labels nested nodes as XML when it encodes them.
    expect(seen).toBeInstanceOf(Y13.XmlFragment)
    expect(seen).not.toBeInstanceOf(Y13.Map)
    // The data is not lost: a v14 client joining later through the same server still reads it.
    const c = client14(s)
    await c.provider.whenSynced
    await waitFor(
      () => c.doc.get('cards').getAttr('c1')?.getAttr('title') === 'v14 card',
      'a late v14 client to read it',
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
