import { describe, expect, test } from 'vitest'
import { entries, mergeUpdatesV2, update, v1Update } from '#y'
import { conformanceCases, MemoryDocumentStore, type DocumentStore } from '#entry'

const memoryBackend = () => {
  const docs = new Map<string, Uint8Array>()
  return { open: () => new MemoryDocumentStore(docs) }
}

describe('MemoryDocumentStore', () => {
  for (const c of conformanceCases(memoryBackend)) test(c.name, c.run)

  test('rejects bytes that are not an update and stays writable', async () => {
    const store = new MemoryDocumentStore()
    await expect(store.append('doc', new Uint8Array([255, 255, 255]))).rejects.toThrow()
    await store.append('doc', update('a', '1'))
    expect(entries(await store.load('doc'))).toEqual({ a: '1' })
  })

  test('rejects a truncated or v1 update, and the document still loads', async () => {
    const store = new MemoryDocumentStore()
    const u = update('a', '1')
    await store.append('doc', u)
    await expect(store.append('doc', u.subarray(0, u.length - 1))).rejects.toThrow()
    await expect(store.append('doc', v1Update('a', '1'))).rejects.toThrow()
    expect(entries(await store.load('doc'))).toEqual({ a: '1' })
  })

  test('does not alias the caller or the loaded buffer', async () => {
    const store = new MemoryDocumentStore()
    const u = update('a', '1')
    const copy = u.slice()
    await store.append('doc', u)
    u.fill(0)
    const [first] = (await store.load('doc'))!
    expect(first).toEqual(copy)
    first!.fill(0)
    expect(await store.load('doc')).toEqual([copy])
  })
})

/** Keeps each appended update as it came and loads them unmerged. */
class RowStore implements DocumentStore {
  constructor(readonly rows = new Map<string, Uint8Array[]>()) {}
  async load(name: string) {
    return this.rows.get(name)?.slice() ?? null
  }
  async append(name: string, update: Uint8Array) {
    this.rows.set(name, [...(this.rows.get(name) ?? []), update])
  }
  async delete(name: string) {
    this.rows.delete(name)
  }
}

describe('a store that loads its updates unmerged', () => {
  const rows = () => {
    const rows = new Map<string, Uint8Array[]>()
    return { open: () => new RowStore(rows) }
  }
  for (const c of conformanceCases(rows)) test(c.name, c.run)
})

const base = (store: DocumentStore): DocumentStore => ({
  load: (n) => store.load(n),
  append: (n, u) => store.append(n, u),
  delete: (n) => store.delete(n),
})

// The helper has to catch real violations, not just pass a good store.
describe('conformance helper catches broken backends', () => {
  const broken = (name: string, wrap: (store: DocumentStore) => DocumentStore) => {
    const cases = conformanceCases(() => {
      const docs = new Map<string, Uint8Array>()
      return { open: () => wrap(new MemoryDocumentStore(docs)) }
    })
    return cases.filter((c) => c.name === name)[0]!
  }

  test('a store that loses concurrent appends', async () => {
    const lossy = (store: DocumentStore): DocumentStore => ({
      ...base(store),
      // read-modify-write with a yield in between loses concurrent updates
      append: async (name, update) => {
        const prev = await store.load(name)
        await new Promise((r) => setTimeout(r, 1))
        const merged = prev ? mergeUpdatesV2([...prev, update]) : update
        ;(store as MemoryDocumentStore).docs.set(name, merged)
      },
    })
    await expect(
      broken('concurrent appends from one handle are all kept', lossy).run(),
    ).rejects.toThrow(/storage conformance/)
  })

  test('a store whose delete leaves data behind', async () => {
    const noDelete = (store: DocumentStore): DocumentStore => ({
      ...base(store),
      delete: async () => {},
    })
    await expect(
      broken('delete removes the document and it can be written again', noDelete).run(),
    ).rejects.toThrow(/storage conformance/)
  })

  test('a store that returns an empty array instead of null for unknown documents', async () => {
    const empty = (store: DocumentStore): DocumentStore => ({
      ...base(store),
      load: async (n) => (await store.load(n)) ?? [],
    })
    await expect(broken('load returns null for an unknown document', empty).run()).rejects.toThrow(
      /storage conformance/,
    )
  })

  test('a store whose load resolves one update, not an array of them', async () => {
    const bare = (store: DocumentStore): DocumentStore => ({
      ...base(store),
      load: async (n) => {
        const updates = await store.load(n)
        return (updates && mergeUpdatesV2(updates)) as unknown as Uint8Array[]
      },
    })
    await expect(
      broken('load returns updates that apply to the merged document', bare).run(),
    ).rejects.toThrow(/storage conformance/)
  })

  test('a store that shares names across documents', async () => {
    const shared = (store: DocumentStore): DocumentStore => ({
      ...base(store),
      append: (_n, u) => store.append('x', u),
      load: (_n) => store.load('x'),
    })
    await expect(
      broken('documents with different names are isolated', shared).run(),
    ).rejects.toThrow(/storage conformance/)
  })

  test('a store that drops updates past a few hundred', async () => {
    let count = 0
    const capped = (store: DocumentStore): DocumentStore => ({
      ...base(store),
      append: async (n, u) => {
        if (++count <= 100) await store.append(n, u)
      },
    })
    await expect(broken('300 appends still load in full', capped).run()).rejects.toThrow(
      /storage conformance/,
    )
  })

  test('a store whose handles do not see each other', async () => {
    const cases = conformanceCases(() => ({ open: () => new MemoryDocumentStore() }))
    const c = cases.find((c) => c.name.startsWith('a resolved append is visible'))!
    await expect(c.run()).rejects.toThrow(/storage conformance/)
  })
})
