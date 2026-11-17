import { Doc, array, map, text } from '#y'
import { describe, expect, it } from 'vitest'
import { MemoryStorage, OpfsPersistence } from '#entry'
import type { PersistenceOptions } from '#entry'
import { Hub, until } from './channels.js'

async function tab(storage: MemoryStorage, hub: Hub, options: PersistenceOptions = {}) {
  const doc = new Doc()
  const p = new OpfsPersistence('doc', doc, storage, { broadcast: hub.factory, ...options })
  await p.whenSynced
  return { doc, p }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('cross-tab broadcast (deterministic channel)', () => {
  it("applies another tab's update without a flush or reload", async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    text(a.doc, 't').insert(0, 'live')
    await a.p.flush()
    await until(() => text(b.doc, 't').toString() === 'live')
  })

  it('does not echo: a receiving tab neither persists nor broadcasts what it applied', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    hub.hold = true // otherwise delivery and any echo finish before we can take a baseline
    text(a.doc, 't').insert(0, 'x')
    await a.p.flush()
    const posts = hub.posts
    const size = storage.files.get('doc.0.ylog')!.length
    hub.hold = false
    hub.release()
    await until(() => text(b.doc, 't').toString() === 'x')
    await b.p.flush()
    await settle()
    expect(hub.posts).toBe(posts)
    expect(storage.files.get('doc.0.ylog')!.length).toBe(size)
  })

  it('a receiver keeps appending without re-reading the log', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    let reads = 0
    const read = storage.read.bind(storage)
    storage.read = async (n) => (reads++, read(n))
    for (let i = 0; i < 10; i++) {
      array(a.doc, 'a').push([i])
      await a.p.flush()
      await until(() => array(b.doc, 'a').length === i + 1)
      array(b.doc, 'b').push([i])
      await b.p.flush()
      await until(() => array(a.doc, 'b').length === i + 1)
    }
    expect(reads).toBe(0)
  })

  it('stays usable across compaction in either tab', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub, { maxRecords: 3 })
    const b = await tab(storage, hub, { maxRecords: 3 })
    let reads = 0
    const read = storage.read.bind(storage)
    storage.read = async (n) => (reads++, read(n))
    for (let i = 0; i < 20; i++) {
      const [w, r] = i % 2 ? [b, a] : [a, b]
      array(w.doc, 'k').push([i])
      await w.p.flush()
      await until(() => array(r.doc, 'k').length === i + 1)
    }
    expect(array(a.doc, 'k').toArray()).toEqual([...Array(20).keys()])
    expect(array(b.doc, 'k').toArray()).toEqual([...Array(20).keys()])
    expect(reads).toBe(0) // compaction messages carried the new position
    const c = await tab(storage, hub)
    expect(array(c.doc, 'k').length).toBe(20)
  })

  it('a late-joining tab loads the past and then follows live', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    text(a.doc, 't').insert(0, 'before')
    await a.p.flush()
    const c = await tab(storage, hub)
    expect(text(c.doc, 't').toString()).toBe('before')
    text(a.doc, 't').insert(6, '+after')
    await a.p.flush()
    await until(() => text(c.doc, 't').toString() === 'before+after')
  })

  it('repairs a lost message when the next one arrives', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    hub.hold = true
    array(a.doc, 'k').push(['lost'])
    await a.p.flush()
    hub.drop()
    hub.hold = false
    await settle()
    expect(array(b.doc, 'k').length).toBe(0)

    array(a.doc, 'k').push(['seen'])
    await a.p.flush()
    await until(() => array(b.doc, 'k').length === 2)
    expect(array(b.doc, 'k').toArray()).toEqual(['lost', 'seen'])
  })

  it("a lost message is also repaired by the receiver's own next flush", async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    hub.hold = true
    text(a.doc, 't').insert(0, 'a')
    await a.p.flush()
    hub.drop()
    text(b.doc, 'u').insert(0, 'b')
    await b.p.flush()
    expect(text(b.doc, 't').toString()).toBe('a')
  })

  it('refresh() pulls in changes whose message was lost', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    hub.hold = true
    text(a.doc, 't').insert(0, 'a')
    await a.p.flush()
    hub.drop()
    await b.p.refresh()
    expect(text(b.doc, 't').toString()).toBe('a')
  })

  it('tolerates reordered and duplicated delivery', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    hub.hold = true
    for (let i = 0; i < 5; i++) {
      array(a.doc, 'k').push([i])
      await a.p.flush()
    }
    hub.release({ reverse: true, twice: true })
    await until(() => array(b.doc, 'k').length === 5)
    expect(array(b.doc, 'k').toArray()).toEqual([0, 1, 2, 3, 4])

    // And it did not wedge: a write from b is still stored and reaches a.
    hub.hold = false
    array(b.doc, 'k').push([5])
    await b.p.flush()
    await until(() => array(a.doc, 'k').length === 6)
    const c = await tab(storage, hub)
    expect(array(c.doc, 'k').toArray()).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('large updates send a signal and the receiver re-reads', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    const big = 'x'.repeat(400 * 1024)
    let sentBytes = 0
    const post = hub.send.bind(hub)
    hub.send = (from, name, data) => (
      (sentBytes += JSON.stringify(data).length),
      post(from, name, data)
    )
    text(a.doc, 't').insert(0, big)
    await a.p.flush()
    await until(() => text(b.doc, 't').length === big.length)
    expect(sentBytes).toBeLessThan(1000)
  })

  it('broadcast: false opens no channel and still converges on flush', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub, { broadcast: false })
    const b = await tab(storage, hub, { broadcast: false })
    text(a.doc, 't').insert(0, 'quiet')
    await a.p.flush()
    await settle()
    expect(hub.posts).toBe(0)
    expect(text(b.doc, 't').toString()).toBe('')
    text(b.doc, 'u').insert(0, 'x')
    await b.p.flush()
    expect(text(b.doc, 't').toString()).toBe('quiet')
  })

  it('closes its channel on destroy', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    await b.p.destroy()
    text(a.doc, 't').insert(0, 'x')
    await a.p.flush()
    await settle()
    expect(text(b.doc, 't').toString()).toBe('')
  })
})

describe('cross-tab broadcast (global BroadcastChannel)', () => {
  const hasGlobal = typeof BroadcastChannel !== 'undefined'

  it.runIf(hasGlobal)('works with the default channel, scoped by storage', async () => {
    const shared = new MemoryStorage()
    const other = new MemoryStorage()
    const make = async (storage: MemoryStorage) => {
      const doc = new Doc()
      const p = new OpfsPersistence('doc', doc, storage)
      await p.whenSynced
      return { doc, p }
    }
    const a = await make(shared)
    const b = await make(shared)
    const stranger = await make(other)
    text(a.doc, 't').insert(0, 'hi')
    await a.p.flush()
    await until(() => text(b.doc, 't').toString() === 'hi')
    await settle()
    expect(text(stranger.doc, 't').toString()).toBe('')
    await Promise.all([a.p.destroy(), b.p.destroy(), stranger.p.destroy()])
  })
})
