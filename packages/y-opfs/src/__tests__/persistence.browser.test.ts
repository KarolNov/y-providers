import { Doc, array, map, text } from '#y'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IdbStorage,
  OpfsPersistence,
  OpfsStorage,
  WorkerStorage,
  openStorage,
  opfsSupported,
} from '#entry'
import type { Storage } from '#entry'
import { ByteFileStore, conformanceCases } from '#log'

const uid = () => `t${Math.random().toString(36).slice(2)}`
const newWorker = () => new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' })

async function roundTrip(open: () => Storage) {
  const name = uid()
  const doc = new Doc()
  const p = new OpfsPersistence(name, doc, open())
  await p.whenSynced
  text(doc, 't').insert(0, 'browser')
  map(doc, 'm').set('n', 42)
  await p.destroy()

  const doc2 = new Doc()
  const p2 = new OpfsPersistence(name, doc2, open())
  await p2.whenSynced
  expect(text(doc2, 't').toString()).toBe('browser')
  expect(map(doc2, 'm').get('n')).toBe(42)
  await p2.clearData()
  expect(await open().read(`${name}.0.ylog`)).toBeNull()
}

describe('browser backends', () => {
  const workers: Worker[] = []
  afterEach(() => workers.splice(0).forEach((w) => w.terminate()))
  const workerStorage = () => {
    const w = newWorker()
    workers.push(w)
    return new WorkerStorage(w)
  }

  it('reports OPFS support on the main thread (sync handles live in workers)', () => {
    expect(opfsSupported()).toBe(true)
  })

  it('round-trips through the OPFS worker', () => roundTrip(workerStorage))
  it('round-trips through IndexedDB', () => {
    const db = uid()
    return roundTrip(() => new IdbStorage(db))
  })
  const deleteDb = (name: string) =>
    new Promise<'deleted' | 'blocked'>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve('deleted')
      req.onblocked = () => resolve('blocked')
      req.onerror = () => reject(req.error)
    })

  it('IdbStorage.close() lets deleteDatabase() through, and later calls reject', async () => {
    const name = uid()
    const s = new IdbStorage(name)
    await s.write('f', new Uint8Array([1]))
    await s.close()
    expect(await deleteDb(name)).toBe('deleted')
    await expect(s.read('f')).rejects.toThrow(/closed/)
  })

  it('an idle IdbStorage does not block deleteDatabase() from another connection', async () => {
    const name = uid()
    const s = new IdbStorage(name)
    await s.write('f', new Uint8Array([1]))
    expect(await deleteDb(name)).toBe('deleted')
    await expect(s.read('f')).rejects.toThrow(/closed/)
  })

  it('IdbStorage.size tracks append, write and remove without reading data', async () => {
    const s = new IdbStorage(uid())
    expect(await s.size('f')).toBeNull()
    await s.append('f', new Uint8Array(3))
    await s.append('f', new Uint8Array(4))
    expect(await s.size('f')).toBe(7)
    expect((await s.read('f'))!.length).toBe(7)
    await s.write('f', new Uint8Array(2))
    expect(await s.size('f')).toBe(2)
    await s.append('f', new Uint8Array(5))
    expect(await s.size('f')).toBe(7)
    await s.remove('f')
    expect(await s.size('f')).toBeNull()
    expect(await s.read('f')).toBeNull()
  })
  for (const [label, open] of [
    ['OPFS worker', () => workerStorage()],
    ['IndexedDB', () => new IdbStorage(uid())],
  ] as const) {
    it(`${label}: appendIfSize appends only to a file of exactly that size`, async () => {
      const s = open()
      const f = uid()
      expect(await s.appendIfSize!(f, new Uint8Array([1]), 0)).toBe(false)
      expect(await s.size(f)).toBeNull()
      await s.write(f, new Uint8Array([1, 2]))
      expect(await s.appendIfSize!(f, new Uint8Array([3]), 1)).toBe(false)
      expect(await s.appendIfSize!(f, new Uint8Array([3]), 2)).toBe(true)
      expect(await s.appendIfSize!(f, new Uint8Array([4]), 3)).toBe(true)
      expect(await s.read(f)).toEqual(new Uint8Array([1, 2, 3, 4]))
      expect(await s.size(f)).toBe(4)
      await s.remove(f)
      await s.close?.()
    })
  }

  it('openStorage opens OPFS through the worker when it is available', async () => {
    const { storage, active } = await openStorage({
      createWorker: () => (workers.push(newWorker()), workers.at(-1)!),
    })
    expect(active).toBe('opfs')
    expect(storage).toBeInstanceOf(WorkerStorage)
    await storage.write('f', new Uint8Array([1]))
    expect(await storage.read('f')).toEqual(new Uint8Array([1]))
    await storage.remove('f')
  })
  it("openStorage order ['indexeddb'] never starts a worker", async () => {
    let spawned = 0
    const { storage, active } = await openStorage({
      order: ['indexeddb'],
      createWorker: () => (spawned++, newWorker()),
    })
    expect(active).toBe('indexeddb')
    expect(storage).toBeInstanceOf(IdbStorage)
    expect(spawned).toBe(0)
    await storage.close?.()
  })
  it('openStorage skips a worker that fails to load, and uses IndexedDB', async () => {
    const { storage, active } = await openStorage({
      createWorker: () => (
        workers.push(
          new Worker(new URL('./missing.worker.ts', import.meta.url), { type: 'module' }),
        ),
        workers.at(-1)!
      ),
    })
    expect(active).toBe('indexeddb')
    await storage.close?.()
  })
  it("openStorage order ['opfs'] refuses to fall back", async () => {
    await expect(openStorage({ order: ['opfs'] })).rejects.toThrow(/createWorker/)
  })
  it('openStorage uses IndexedDB without a worker factory', async () => {
    const { storage, active } = await openStorage()
    expect(active).toBe('indexeddb')
    await storage.close?.()
  })
  it('OpfsStorage cannot run on the main thread (sync handles are worker-only)', async () => {
    const s = new OpfsStorage(uid())
    await expect(s.append('x', new Uint8Array([1]))).rejects.toThrow()
  })
})

describe('storage running out', () => {
  const workers: Worker[] = []
  afterEach(() => workers.splice(0).forEach((w) => w.terminate()))
  /** OPFS worker whose files cannot grow past `limit` bytes, writing short like Firefox. */
  const shortWriteStorage = (limit: number) => {
    const w = new Worker(new URL('./short-write.worker.ts', import.meta.url), {
      type: 'module',
      name: String(limit),
    })
    workers.push(w)
    return new WorkerStorage(w)
  }
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: Error) => e.name,
    )

  it('OPFS: an append that does not fit is rolled back and rejects with QuotaExceededError', async () => {
    const s = shortWriteStorage(10)
    const f = uid()
    await s.append(f, new Uint8Array([1, 2, 3, 4, 5, 6]))
    expect(await failure(s.append(f, new Uint8Array(6).fill(9)))).toBe('QuotaExceededError')
    expect(await s.read(f)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
  })

  it('OPFS: a write cuts the file to length, and one that does not fit leaves a new file empty', async () => {
    const s = shortWriteStorage(10)
    const f = uid()
    await s.write(f, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    await s.write(f, new Uint8Array([1, 2, 3]))
    expect(await s.read(f)).toEqual(new Uint8Array([1, 2, 3]))
    const g = uid()
    expect(await failure(s.write(g, new Uint8Array(12)))).toBe('QuotaExceededError')
    expect(await s.size(g)).toBe(0)
  })

  it('OPFS: every acknowledged update survives filling the storage, compactions included', async () => {
    const name = uid()
    const doc = new Doc()
    const p = new OpfsPersistence(name, doc, shortWriteStorage(8000), {
      maxBytes: 3000,
      broadcast: false,
      onError: () => {},
    })
    await p.whenSynced
    const m = map(doc, 'm')
    let acked = 0
    for (let i = 0; i < 100; i++) {
      m.set(String(i), new Uint8Array(400).fill(i))
      const error = await failure(p.flush())
      if (error) {
        expect(error).toBe('QuotaExceededError')
        break
      }
      acked = i + 1
    }
    expect(acked).toBeGreaterThan(0)
    expect(acked).toBeLessThan(100)
    await p.destroy()

    const doc2 = new Doc()
    const w = newWorker()
    workers.push(w)
    const p2 = new OpfsPersistence(name, doc2, new WorkerStorage(w), {
      broadcast: false,
    })
    await p2.whenSynced
    for (let i = 0; i < acked; i++) expect(map(doc2, 'm').has(String(i))).toBe(true)
    await p2.clearData()
  })

  it('IndexedDB: a failed request rejects with its own error, not a bare AbortError', async () => {
    const s = new IdbStorage(uid())
    await s.append('f', new Uint8Array(3))
    // Make the size-record put fail asynchronously, as a put over quota does.
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = IDBObjectStore.prototype.add
    try {
      expect(await failure(s.append('f', new Uint8Array(4)))).toBe('ConstraintError')
    } finally {
      IDBObjectStore.prototype.put = put
    }
    expect(await s.size('f')).toBe(3)
  })

  it('IndexedDB: a request that throws inside a callback rejects with that error', async () => {
    const s = new IdbStorage(uid())
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = () => {
      throw new DOMException('transaction is failing', 'ReadOnlyError')
    }
    try {
      expect(await failure(s.append('f', new Uint8Array(4)))).toBe('ReadOnlyError')
    } finally {
      IDBObjectStore.prototype.put = put
    }
    expect(await s.size('f')).toBeNull()
  })

  it("IndexedDB: Firefox's refusal of writes once over quota is a QuotaExceededError", async () => {
    const s = new IdbStorage(uid())
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = () => {
      throw new DOMException(
        'A mutation operation was attempted on a database that did not allow mutations.',
        'InvalidStateError',
      )
    }
    try {
      expect(await failure(s.append('f', new Uint8Array(4)))).toBe('QuotaExceededError')
    } finally {
      IDBObjectStore.prototype.put = put
    }
  })
})

describe('multiple writers (simulated tabs, shared Web Locks)', () => {
  const workers: Worker[] = []
  afterEach(() => workers.splice(0).forEach((w) => w.terminate()))
  const tabStorage = () => {
    const w = newWorker()
    workers.push(w)
    return new WorkerStorage(w)
  }
  const idb = (db: string) => () => new IdbStorage(db)

  for (const [label, makeStorage, broadcast] of [
    ['OPFS', () => tabStorage, true] as const,
    ['IndexedDB', () => idb(uid()), true] as const,
    ['OPFS, no broadcast', () => tabStorage, false] as const,
    ['IndexedDB, no broadcast', () => idb(uid()), false] as const,
  ]) {
    it(`${label}: concurrent edits and compactions from two tabs all survive`, async () => {
      const name = uid()
      const open = makeStorage()
      const TABS = 4
      const N = 60
      const docs = Array.from({ length: TABS }, () => new Doc())
      const ps = docs.map((d) => new OpfsPersistence(name, d, open(), { maxRecords: 2, broadcast }))
      await Promise.all(ps.map((p) => p.whenSynced))

      // Tiny maxRecords forces a compaction every other write, so compactions
      // and appends from different tabs constantly collide.
      await Promise.all(
        docs.map(async (doc, t) => {
          for (let i = 0; i < N; i++) {
            array(doc, `k${t}`).push([i])
            if (i % 3 === 0) await ps[t]!.flush()
          }
          await ps[t]!.flush()
        }),
      )
      await Promise.all(ps.map((p) => p.destroy()))

      const c = new Doc()
      const pc = new OpfsPersistence(name, c, open())
      await pc.whenSynced
      for (let t = 0; t < TABS; t++)
        expect(array(c, `k${t}`).toArray()).toEqual([...Array(N).keys()])
      await pc.clearData()
    })

    it(`${label}: a tab picks up the other tab's writes on its next flush`, async () => {
      const name = uid()
      const open = makeStorage()
      const a = new Doc()
      const b = new Doc()
      const pa = new OpfsPersistence(name, a, open(), { broadcast })
      const pb = new OpfsPersistence(name, b, open(), { broadcast })
      await Promise.all([pa.whenSynced, pb.whenSynced])

      text(a, 't').insert(0, 'from-a')
      await pa.flush()
      text(b, 'u').insert(0, 'from-b')
      await pb.flush()
      expect(text(b, 't').toString()).toBe('from-a')
      await Promise.all([pa.destroy(), pb.destroy()])
    })
  }
})

// The conformance helper's documents are named alike in every case, so each
// backend gets its own file-name prefix and cases never see each other's data.
const prefixed = (inner: Storage, prefix: string): Storage => ({
  scope: inner.scope,
  read: (n) => inner.read(prefix + n),
  size: (n) => inner.size(prefix + n),
  append: (n, d) => inner.append(prefix + n, d),
  appendIfSize: inner.appendIfSize && ((n, d, size) => inner.appendIfSize!(prefix + n, d, size)),
  write: (n, d) => inner.write(prefix + n, d),
  remove: (n) => inner.remove(prefix + n),
  close: () => inner.close?.(),
})

describe('ByteFileStore over browser backends', () => {
  describe('OPFS', () => {
    const workers: Worker[] = []
    afterEach(() => workers.splice(0).forEach((w) => w.terminate()))
    const make = () => {
      const prefix = `${uid()}-`
      return {
        open: () => {
          const w = newWorker()
          workers.push(w)
          return new ByteFileStore(prefixed(new WorkerStorage(w), prefix), { maxRecords: 7 })
        },
      }
    }
    for (const c of conformanceCases(make)) it(c.name, c.run)
  })

  describe('IndexedDB', () => {
    const make = () => {
      const db = uid()
      return { open: () => new ByteFileStore(new IdbStorage(db), { maxRecords: 7 }) }
    }
    for (const c of conformanceCases(make)) it(c.name, c.run)
  })
})
