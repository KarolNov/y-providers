import { Doc, array, map, text } from '#y'
import { describe, expect, it } from 'vitest'
import { MemoryStorage, OpfsPersistence } from '#entry'
import type { PersistenceEvent, PersistenceOptions } from '#entry'
import { Hub, until } from './channels.js'

async function tab(storage: MemoryStorage, hub: Hub, options: PersistenceOptions = {}) {
  const events: PersistenceEvent[] = []
  const doc = new Doc()
  const p = new OpfsPersistence('doc', doc, storage, {
    broadcast: hub.factory,
    onEvent: (e) => events.push(e),
    ...options,
  })
  await p.whenSynced
  return { doc, p, events }
}

const types = (events: PersistenceEvent[]) => events.map((e) => e.type)

describe('onEvent', () => {
  it('reports the load, a flush with its broadcast, and a compaction', async () => {
    const a = await tab(new MemoryStorage(), new Hub(), { broadcast: false })
    expect(types(a.events)).toEqual(['load'])
    expect(a.events[0]!.position).toMatchObject({ generation: 1, records: 1 })

    array(a.doc, 'x').push([1])
    array(a.doc, 'x').push([2])
    await a.p.flush()
    const flush = a.events.find((e) => e.type === 'flush')!
    expect(flush).toMatchObject({ type: 'flush', updates: 2 })
    expect(flush.position.records).toBe(2)

    await a.p.compact()
    const compact = a.events.find((e) => e.type === 'compact')!
    expect(compact.position).toMatchObject({ generation: 2, records: 1 })
  })

  it('reports sent and received broadcasts, and whether the receiver had to re-read', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    array(a.doc, 'x').push([1])
    await a.p.flush()
    expect(a.events.at(-1)).toMatchObject({ type: 'broadcast-sent', kind: 'update' })
    await until(() => b.events.some((e) => e.type === 'broadcast-received'))
    expect(b.events.find((e) => e.type === 'broadcast-received')).toMatchObject({
      kind: 'update',
      adopted: true,
    })

    await a.p.compact()
    await until(() => b.events.filter((e) => e.type === 'broadcast-received').length === 2)
    expect(b.events.at(-1)).toMatchObject({ kind: 'compacted', adopted: true })
    expect(types(b.events)).not.toContain('resync')
  })

  it('reports a resync when a broadcast was missed', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    hub.hold = true
    array(a.doc, 'x').push([1])
    await a.p.flush()
    hub.drop()

    array(b.doc, 'y').push([1])
    await b.p.flush()
    hub.drop() // a misses b's broadcast as well
    hub.hold = false
    expect(b.events.find((e) => e.type === 'resync')).toMatchObject({ reason: 'write' })
    expect(array(b.doc, 'x').length).toBe(1)

    a.events.length = 0
    await a.p.refresh()
    expect(a.events.find((e) => e.type === 'resync')).toMatchObject({ reason: 'refresh' })
  })

  it('keeps going if the listener throws', async () => {
    const errors: unknown[] = []
    const a = await tab(new MemoryStorage(), new Hub(), {
      broadcast: false,
      onEvent: () => {
        throw new Error('listener')
      },
      onError: (e) => errors.push(e),
    })
    array(a.doc, 'x').push([1])
    await a.p.flush()
    expect(errors.length).toBeGreaterThan(0)
    expect(array(a.doc, 'x').length).toBe(1)
  })
})

describe('clearData with other tabs open', () => {
  it('tells the other tabs, which detach instead of writing their stale doc back', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    array(a.doc, 'x').push(['old'])
    await a.p.flush()
    await until(() => array(b.doc, 'x').length === 1)

    await a.p.clearData()
    await until(() => b.events.some((e) => e.type === 'cleared'))
    expect(a.events.at(-1)).toMatchObject({ type: 'cleared', remote: false })
    expect(b.events.find((e) => e.type === 'cleared')).toMatchObject({ remote: true })
    expect(storage.files.size).toBe(0)

    array(b.doc, 'x').push(['after clear'])
    await b.p.flush()
    expect(storage.files.size).toBe(0)

    const c = await tab(storage, hub)
    expect(array(c.doc, 'x').length).toBe(0)
  })

  it('a tab that missed the message writes its own state back on its next write', async () => {
    const storage = new MemoryStorage()
    const hub = new Hub()
    const a = await tab(storage, hub)
    const b = await tab(storage, hub)
    array(a.doc, 'x').push(['old'])
    await a.p.flush()
    await until(() => array(b.doc, 'x').length === 1)

    hub.hold = true
    await a.p.clearData()
    hub.drop()
    hub.hold = false
    array(b.doc, 'x').push(['new'])
    await b.p.flush()

    const c = await tab(storage, hub)
    expect(array(c.doc, 'x').toArray()).toEqual(['old', 'new'])
  })
})
