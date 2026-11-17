import { Doc, array, map, text } from '#y'
import { afterEach, describe, expect, it } from 'vitest'
import { IdbStorage, OpfsPersistence, WorkerStorage, openStorage, opfsSupported } from '#entry'

// Runs in WebKit's non-persistent data store (Playwright's default context), the kind Safari
// uses for private windows: OPFS looks supported, but every operation fails.

const uid = () => `t${Math.random().toString(36).slice(2)}`
const newWorker = () => new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' })

describe('WebKit private browsing', () => {
  const workers: Worker[] = []
  afterEach(() => workers.splice(0).forEach((w) => w.terminate()))
  const createWorker = () => (workers.push(newWorker()), workers.at(-1)!)

  it('reports OPFS as supported, but the worker cannot open it', async () => {
    expect(opfsSupported()).toBe(true)
    const opfs = new WorkerStorage(createWorker())
    await expect(opfs.read(`${uid()}.0.ylog`)).rejects.toMatchObject({ name: 'UnknownError' })
  })

  it('openStorage skips OPFS for IndexedDB, and a document round-trips', async () => {
    const name = uid()
    const directory = uid()
    const opened = await openStorage({ createWorker, directory })
    expect(opened.active).toBe('indexeddb')
    const doc = new Doc()
    const p = new OpfsPersistence(name, doc, opened.storage)
    await p.whenSynced
    text(doc, 't').insert(0, 'private')
    await p.destroy()

    expect(await new IdbStorage(directory).read(`${name}.0.ylog`)).not.toBeNull()
    const doc2 = new Doc()
    const p2 = new OpfsPersistence(
      name,
      doc2,
      (await openStorage({ createWorker, directory })).storage,
    )
    await p2.whenSynced
    expect(text(doc2, 't').toString()).toBe('private')
    await p2.destroy()
  })

  it("openStorage order ['opfs'] fails loudly instead of falling back", async () => {
    await expect(openStorage({ order: ['opfs'], createWorker })).rejects.toMatchObject({
      name: 'UnknownError',
    })
  })
})
