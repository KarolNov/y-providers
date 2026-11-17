import { mkdtemp, readdir, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Doc, array, map, text } from '#y'
import { describe, expect, it } from 'vitest'
import { ByteFileStore, conformanceCases } from '#log'
import { MemoryStorage, OpfsPersistence } from '#entry'
import { NodeFsStorage } from '../node.js'

async function reopen(storage: MemoryStorage | NodeFsStorage, name = 'doc') {
  const doc = new Doc()
  const p = new OpfsPersistence(name, doc, storage)
  await p.whenSynced
  return { doc, p }
}

describe('OpfsPersistence', () => {
  it('round-trips edits', async () => {
    const storage = new MemoryStorage()
    const a = await reopen(storage)
    text(a.doc, 't').insert(0, 'hello')
    map(a.doc, 'm').set('k', 1)
    await a.p.destroy()
    const b = await reopen(storage)
    expect(text(b.doc, 't').toString()).toBe('hello')
    expect(map(b.doc, 'm').get('k')).toBe(1)
  })

  it('coalesces synchronous edits into one record', async () => {
    const storage = new MemoryStorage()
    const a = await reopen(storage)
    const before = storage.files.get('doc.0.ylog')!.length
    for (let i = 0; i < 100; i++) array(a.doc, 'a').push([i])
    await a.p.flush()
    const b = await reopen(storage)
    expect(array(b.doc, 'a').length).toBe(100)
    expect(storage.files.get('doc.0.ylog')!.length).toBeGreaterThan(before)
  })

  it('keeps edits made before load finishes', async () => {
    const storage = new MemoryStorage()
    const seed = await reopen(storage)
    text(seed.doc, 't').insert(0, 'old')
    await seed.p.destroy()

    const doc = new Doc()
    const p = new OpfsPersistence('doc', doc, storage)
    text(doc, 'u').insert(0, 'early')
    await p.whenSynced
    await p.destroy()
    const c = await reopen(storage)
    expect(text(c.doc, 't').toString()).toBe('old')
    expect(text(c.doc, 'u').toString()).toBe('early')
  })

  it('compacts and survives reload', async () => {
    const storage = new MemoryStorage()
    const doc = new Doc()
    const p = new OpfsPersistence('doc', doc, storage, { maxRecords: 5 })
    await p.whenSynced
    for (let i = 0; i < 50; i++) {
      array(doc, 'a').push([i])
      await p.flush()
    }
    await p.destroy()
    expect([...storage.files.keys()]).toHaveLength(1) // old slot removed
    const b = await reopen(storage)
    expect(array(b.doc, 'a').length).toBe(50)
  })

  it('ignores a torn tail and keeps appending correctly', async () => {
    const storage = new MemoryStorage()
    const a = await reopen(storage)
    text(a.doc, 't').insert(0, 'safe')
    await a.p.destroy()
    await storage.append('doc.0.ylog', new Uint8Array([9, 0, 0, 0, 1, 2, 3])) // half-written record
    const b = await reopen(storage)
    expect(text(b.doc, 't').toString()).toBe('safe')
    text(b.doc, 't').insert(4, '!')
    await b.p.destroy()
    const c = await reopen(storage)
    expect(text(c.doc, 't').toString()).toBe('safe!')
  })

  it('recovers when compaction crashed mid-write of the new slot', async () => {
    const storage = new MemoryStorage()
    const a = await reopen(storage)
    text(a.doc, 't').insert(0, 'kept')
    await a.p.destroy()
    await storage.write('doc.1.ylog', new Uint8Array([5, 0, 0, 0, 7, 7])) // garbage new slot
    const b = await reopen(storage)
    expect(text(b.doc, 't').toString()).toBe('kept')
  })

  it('prefers the higher generation when both slots are valid', async () => {
    const storage = new MemoryStorage()
    const doc = new Doc()
    const p = new OpfsPersistence('doc', doc, storage)
    await p.whenSynced
    text(doc, 't').insert(0, 'v1')
    await p.flush()
    const old = storage.files.get('doc.0.ylog')!.slice()
    await p.compact()
    await p.destroy()
    storage.files.set('doc.0.ylog', old) // crash before the old slot was removed
    const b = await reopen(storage)
    expect(text(b.doc, 't').toString()).toBe('v1')
  })

  it('a compaction that runs out of space keeps the update and backs off', async () => {
    class FullStorage extends MemoryStorage {
      full = false
      snapshotWrites = 0
      override async write(name: string, data: Uint8Array) {
        if (!this.full) return super.write(name, data)
        this.snapshotWrites++
        throw new DOMException(`${name}: no room for the snapshot`, 'QuotaExceededError')
      }
    }
    const storage = new FullStorage()
    const errors: unknown[] = []
    const doc = new Doc()
    const p = new OpfsPersistence('doc', doc, storage, {
      maxBytes: 1000,
      onError: (e) => errors.push(e),
    })
    await p.whenSynced
    storage.full = true
    for (let i = 0; i < 60; i++) {
      array(doc, 'a').push([new Uint8Array(100)])
      await p.flush() // each update is appended; only the snapshot fails
    }
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every((e) => (e as DOMException).name === 'QuotaExceededError')).toBe(true)
    // ~5 KB of appends past the threshold: one attempt per extra maxBytes/4,
    // not one per flush.
    expect(storage.snapshotWrites).toBeLessThan(35)
    await p.destroy()
    const b = await reopen(storage)
    expect(array(b.doc, 'a').length).toBe(60)
  })

  it('works on the Node filesystem and clearData wipes it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ymp-'))
    try {
      const storage = new NodeFsStorage(dir)
      const a = await reopen(storage, 'room/1')
      text(a.doc, 't').insert(0, 'disk')
      await a.p.destroy()
      const b = await reopen(storage, 'room/1')
      expect(text(b.doc, 't').toString()).toBe('disk')
      await b.p.clearData()
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('ByteFileStore over Node fs', () => {
  const make = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'y-modern-conformance-'))
    return {
      // independent handles: each opens the directory on its own
      open: () => new ByteFileStore(new NodeFsStorage(dir), { maxRecords: 7 }),
      dispose: () => rm(dir, { recursive: true, force: true }),
    }
  }
  for (const c of conformanceCases(make)) it(c.name, c.run)
})
