import { describe, expect, test } from 'vitest'
import { emptyUpdate, entries, update, v1Update } from '#y'
import {
  ByteFileLog,
  ByteFileStore,
  MemoryStorage,
  conformanceCases,
  webLocks,
  type Storage,
} from '#entry'
import { RECORD_UPDATE, encodeRecord, parseLog } from '../core/log.js'
describe('ByteFileStore over memory', () => {
  // Small thresholds, so the conformance cases compact many times.
  const make = () => {
    const storage = new MemoryStorage()
    return { open: () => new ByteFileStore(storage, { maxRecords: 7 }) }
  }
  for (const c of conformanceCases(make)) test(c.name, c.run)

  test('load hands back the snapshot and each record after it, unmerged', async () => {
    const store = new ByteFileStore(new MemoryStorage())
    const appended = [update('a', '1'), update('b', '2'), update('c', '3')]
    for (const u of appended) await store.append('doc', u)
    expect(await store.load('doc')).toEqual(appended)
  })

  test('rejects a truncated or v1 update, and the document still loads', async () => {
    const store = new ByteFileStore(new MemoryStorage())
    const u = update('a', '1')
    await store.append('doc', u)
    await expect(store.append('doc', u.subarray(0, u.length - 1))).rejects.toThrow()
    await expect(store.append('doc', v1Update('a', '1'))).rejects.toThrow()
    expect(entries(await store.load('doc'))).toEqual({ a: '1' })
  })
})

/** The same files, without `appendIfSize`, so the log checks `size()` and then appends. */
const withoutAppendIfSize = (inner: MemoryStorage): Storage => ({
  scope: inner.scope,
  read: (n) => inner.read(n),
  size: (n) => inner.size(n),
  append: (n, d) => inner.append(n, d),
  write: (n, d) => inner.write(n, d),
  remove: (n) => inner.remove(n),
})

describe('ByteFileStore over memory without appendIfSize', () => {
  const make = () => {
    const storage = withoutAppendIfSize(new MemoryStorage())
    return { open: () => new ByteFileStore(storage, { maxRecords: 7 }) }
  }
  for (const c of conformanceCases(make)) test(c.name, c.run)
})

describe('ByteFileStore on-disk format', () => {
  test('keeps two slot files per document, each a valid CRC log', async () => {
    const storage = new MemoryStorage()
    const store = new ByteFileStore(storage, { maxRecords: 2 })
    for (const k of ['a', 'b', 'c']) await store.append('a doc', withUpdate(k))
    expect([...storage.files.keys()].every((f) => /^a%20doc\.[01]\.ylog$/.test(f))).toBe(true)
    for (const bytes of storage.files.values()) {
      expect(parseLog(bytes).validLength).toBe(bytes.length)
    }
  })

  test('drops a torn tail instead of appending after it', async () => {
    const storage = new MemoryStorage()
    await new ByteFileStore(storage).append('doc', withUpdate('before'))
    const file = 'doc.0.ylog'
    storage.files.set(file, new Uint8Array([...storage.files.get(file)!, 9, 9, 9]))
    const store = new ByteFileStore(storage)
    await store.append('doc', withUpdate('after'))
    const fresh = new ByteFileStore(storage)
    expect(entries(await fresh.load('doc'))).toEqual({ before: 'before', after: 'after' })
  })
})

describe('ByteFileLog', () => {
  for (const [label, wrap] of [
    ['with appendIfSize', (m: MemoryStorage): Storage => m],
    ['without appendIfSize', withoutAppendIfSize],
  ] as const) {
    test(`appendIfFresh appends, and writes nothing once another writer did (${label})`, async () => {
      const files = new MemoryStorage()
      const mine = new ByteFileLog(wrap(files), 'd')
      const theirs = new ByteFileLog(wrap(files), 'd')
      await mine.create(withUpdate('a'))
      expect(await mine.appendIfFresh(withUpdate('b'))).toBeGreaterThan(0)
      await theirs.load()
      await theirs.append(withUpdate('c'))
      const before = files.files.get('d.0.ylog')!.slice()
      expect(await mine.appendIfFresh(withUpdate('d'))).toBeNull()
      expect(files.files.get('d.0.ylog')).toEqual(before)
      expect(entries(await mine.load())).toEqual({ a: 'a', b: 'b', c: 'c' })
      expect(await mine.appendIfFresh(withUpdate('d'))).toBeGreaterThan(0)
    })
  }

  test('keeps a position that follows appends and compaction', async () => {
    const log = new ByteFileLog(new MemoryStorage(), 'd', { maxRecords: 3 })
    expect(await log.load()).toBeNull()
    await log.create(emptyUpdate())
    expect(log.position).toMatchObject({ slot: 0, generation: 1, records: 1 })
    await log.append(update('a', '1'))
    expect(log.full).toBe(false)
    await log.append(update('a', '1'))
    expect(log.full).toBe(true)
    await log.compact()
    expect(log.position).toMatchObject({ slot: 1, generation: 2, records: 1 })
    expect(log.full).toBe(false)
  })

  test('notices that another writer changed the file', async () => {
    const storage = new MemoryStorage()
    const a = new ByteFileLog(storage, 'd')
    const b = new ByteFileLog(storage, 'd')
    await a.create(emptyUpdate())
    await b.load()
    expect(await b.isStale()).toBe(false)
    await a.append(sampleUpdate())
    expect(await b.isStale()).toBe(true)
  })

  test('compacting the stored log throws when its file is gone', async () => {
    const storage = new MemoryStorage()
    const log = new ByteFileLog(storage, 'd')
    await log.create(sampleUpdate())
    await log.remove()
    await expect(log.compact()).rejects.toThrow('nothing to compact')
    expect(storage.files.size).toBe(0)
  })

  test('records are length-prefixed and checksummed', () => {
    const record = encodeRecord(RECORD_UPDATE, new Uint8Array([1, 2, 3]))
    expect(Array.from(record.subarray(0, 4))).toEqual([4, 0, 0, 0])
    expect(parseLog(record).records[0]!.payload).toEqual(new Uint8Array([1, 2, 3]))
  })
})

const sampleUpdate = () => update('x', '1')

const withUpdate = (key: string) => update(key, key)

describe('ByteFileStore when compaction fails', () => {
  test('a failed removal of the old slot loses no appended update', async () => {
    const inner = new MemoryStorage()
    let failRemove = false
    const storage: Storage = {
      scope: inner.scope,
      read: (n) => inner.read(n),
      size: (n) => inner.size(n),
      append: (n, d) => inner.append(n, d),
      write: (n, d) => inner.write(n, d),
      remove: async (n) => {
        if (failRemove) {
          failRemove = false // transient: the clean-up of the new slot goes through
          throw new Error('remove failed')
        }
        return inner.remove(n)
      },
    }
    const errors: unknown[] = []
    const store = new ByteFileStore(storage, { maxRecords: 3, onError: (e) => errors.push(e) })
    await store.append('d', withUpdate('a'))
    await store.append('d', withUpdate('b'))
    failRemove = true
    await store.append('d', withUpdate('c')) // compacts, and fails to remove the old slot
    expect(errors).toHaveLength(1)
    for (const k of ['d1', 'd2', 'd3', 'd4']) await store.append('d', withUpdate(k))
    const keys = Object.keys(entries(await new ByteFileStore(inner).load('d'))).sort()
    expect(keys).toEqual(['a', 'b', 'c', 'd1', 'd2', 'd3', 'd4'])
  })

  test('onError reports it and appends keep working', async () => {
    const inner = new MemoryStorage()
    let failWrites = false
    const storage: Storage = {
      scope: inner.scope,
      read: (n) => inner.read(n),
      size: (n) => inner.size(n),
      append: (n, d) => inner.append(n, d),
      write: async (n, d) => {
        if (failWrites) throw new Error('disk full')
        return inner.write(n, d)
      },
      remove: (n) => inner.remove(n),
    }
    const errors: unknown[] = []
    const store = new ByteFileStore(storage, { maxRecords: 2, onError: (e) => errors.push(e) })
    await store.append('d', withUpdate('a'))
    failWrites = true
    await store.append('d', withUpdate('b'))
    expect(errors).toHaveLength(1)
    await store.append('d', withUpdate('c'))
    failWrites = false
    expect(Object.keys(entries(await store.load('d'))).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('ByteFileStore options', () => {
  test('takes the lock per document, delete forgets it, close closes the storage', async () => {
    let closed = 0
    const storage: Storage = Object.assign(new MemoryStorage(), { close: () => void closed++ })
    const locks: string[] = []
    const store = new ByteFileStore(storage, {
      lock: (name, fn) => (locks.push(name), fn()),
    })
    await store.append('one', withUpdate('a'))
    await store.delete('one')
    expect(await store.load('one')).toBeNull()
    expect(new Set(locks)).toEqual(new Set(['y-append-log:one']))
    await store.close()
    expect(closed).toBe(1)
  })
})

describe('locking', () => {
  const stubLocks = () => {
    const requested: string[] = []
    const nav = globalThis.navigator as unknown as { locks?: unknown }
    const had = Object.getOwnPropertyDescriptor(nav, 'locks')
    Object.defineProperty(nav, 'locks', {
      configurable: true,
      value: { request: (name: string, fn: () => unknown) => (requested.push(name), fn()) },
    })
    return {
      requested,
      restore: () => (had ? Object.defineProperty(nav, 'locks', had) : delete nav.locks),
    }
  }

  test('takes no cross-process lock unless given one', async () => {
    const stub = stubLocks()
    try {
      await new ByteFileStore(new MemoryStorage()).append('d', withUpdate('a'))
      expect(stub.requested).toEqual([])
    } finally {
      stub.restore()
    }
  })

  test('webLocks takes a Web Lock named for the document', async () => {
    const stub = stubLocks()
    try {
      const store = new ByteFileStore(new MemoryStorage(), { lock: webLocks })
      await store.append('d', withUpdate('a'))
      expect(stub.requested).toEqual(['y-append-log:d'])
    } finally {
      stub.restore()
    }
  })
})

describe('ByteFileLog.autoCompact', () => {
  test('compacts once full, and backs off after a failure', async () => {
    const inner = new MemoryStorage()
    let failWrites = true
    const storage: Storage = {
      scope: inner.scope,
      read: (n) => inner.read(n),
      size: (n) => inner.size(n),
      append: (n, d) => inner.append(n, d),
      write: async (n, d) => {
        if (failWrites && n.endsWith('.1.ylog')) throw new Error('full')
        return inner.write(n, d)
      },
      remove: (n) => inner.remove(n),
    }
    const log = new ByteFileLog(storage, 'd', { maxRecords: 2, maxBytes: 1_000_000 })
    await log.create(withUpdate('a'))
    expect(await log.autoCompact(() => withUpdate('a'))).toBe(false) // not full
    await log.append(withUpdate('b'))
    await expect(log.autoCompact(() => withUpdate('ab'))).rejects.toThrow('full')
    // backed off: no further attempt until the log has grown
    expect(await log.autoCompact(() => withUpdate('ab'))).toBe(false)
    failWrites = false
    await log.append(withUpdate('c'))
    await log.append(withUpdate('d'.repeat(300_000)))
    expect(await log.autoCompact(() => withUpdate('abcd'))).toBe(true)
    expect(log.position.generation).toBe(2)
  })
})

describe('ByteFileStore cache', () => {
  test('stays correct with more documents than it keeps positions for', async () => {
    const storage = new MemoryStorage()
    const store = new ByteFileStore(storage, { maxCachedDocuments: 2 })
    for (let round = 0; round < 3; round++) {
      for (const d of ['a', 'b', 'c', 'd']) await store.append(d, withUpdate(`${d}${round}`))
    }
    for (const d of ['a', 'b', 'c', 'd']) {
      expect(Object.keys(entries(await store.load(d))).sort()).toEqual([`${d}0`, `${d}1`, `${d}2`])
    }
    expect(store.cachedDocuments).toBeLessThanOrEqual(2)
  })
})
