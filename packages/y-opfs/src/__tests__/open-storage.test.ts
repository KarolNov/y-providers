import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStorage, WorkerStorage, openStorage } from '#entry'

// Node has neither OPFS nor IndexedDB, so each candidate is faked through the globals it checks.

type Reply = { ok: true; data?: unknown } | { ok: false; error: string; name?: string }

/** A Worker stand-in that answers each request with `reply(callNumber)`. */
function fakeWorker(reply: (call: number) => Reply) {
  let calls = 0
  const worker = {
    terminated: false,
    addEventListener() {},
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage(msg: { id: number }) {
      const r = reply(calls++)
      queueMicrotask(() => worker.onmessage?.({ data: { ...r, id: msg.id } }))
    },
    terminate() {
      worker.terminated = true
    },
  }
  return worker
}

const working = () => fakeWorker(() => ({ ok: true, data: null }))
const broken = () => fakeWorker(() => ({ ok: false, error: 'no OPFS', name: 'UnknownError' }))

/** Make OPFS look supported on the main thread. */
function stubOpfs() {
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({}) } })
  vi.stubGlobal('FileSystemFileHandle', class {})
  vi.stubGlobal('Worker', class {})
}

/** An IndexedDB whose `open` throws, as in a locked-down context. Counts calls. */
function stubBrokenIdb() {
  const idb = {
    opened: 0,
    open() {
      idb.opened++
      throw new DOMException('blocked', 'SecurityError')
    },
  }
  vi.stubGlobal('indexedDB', idb)
  return idb
}

const asWorker = (w: ReturnType<typeof fakeWorker>) => () => w as unknown as Worker

describe('openStorage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the first working candidate and names it in `active`', async () => {
    stubOpfs()
    const idb = stubBrokenIdb()
    const { storage, active } = await openStorage({
      createWorker: asWorker(working()),
    })
    expect(active).toBe('opfs')
    expect(storage).toBeInstanceOf(WorkerStorage)
    expect(idb.opened).toBe(0)
  })

  it('stops at the first that opens, without trying later ones', async () => {
    const idb = stubBrokenIdb()
    const { storage, active } = await openStorage({
      order: ['memory', 'indexeddb'],
    })
    expect(active).toBe('memory')
    expect(storage).toBeInstanceOf(MemoryStorage)
    expect(idb.opened).toBe(0)
  })

  it('skips OPFS whose APIs exist but fail on open, and closes it', async () => {
    stubOpfs()
    const worker = broken()
    const { active, skipped } = await openStorage({
      order: ['opfs', 'memory'],
      createWorker: asWorker(worker),
    })
    expect(active).toBe('memory')
    expect(worker.terminated).toBe(true)
    expect(skipped).toMatchObject([{ backend: 'opfs', error: { name: 'UnknownError' } }])
  })

  it('skips a candidate that never answers the probe', async () => {
    vi.useFakeTimers()
    try {
      stubOpfs()
      const silent = Object.assign(working(), { postMessage() {} })
      const opened = openStorage({ order: ['opfs', 'memory'], createWorker: asWorker(silent) })
      await vi.advanceTimersByTimeAsync(20_000)
      const { active, skipped } = await opened
      expect(active).toBe('memory')
      expect(silent.terminated).toBe(true)
      expect(String(skipped[0]?.error)).toMatch(/did not answer/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips IndexedDB that exists but throws on open', async () => {
    stubBrokenIdb()
    const { active } = await openStorage({ order: ['indexeddb', 'memory'] })
    expect(active).toBe('memory')
  })

  it('skips candidates that are not supported here', async () => {
    const { active } = await openStorage({
      order: ['opfs', 'indexeddb', 'memory'],
      createWorker: asWorker(working()),
    })
    expect(active).toBe('memory')
  })

  it('retries the probe once, so a transient failure keeps the candidate', async () => {
    stubOpfs()
    const worker = fakeWorker((call) =>
      call === 0 ? { ok: false, error: 'transient', name: 'UnknownError' } : { ok: true },
    )
    const { active } = await openStorage({
      order: ['opfs', 'memory'],
      createWorker: asWorker(worker),
    })
    expect(active).toBe('opfs')
    expect(worker.terminated).toBe(false)
  })

  it('a one-element order pins that backend and throws its error when it fails', async () => {
    stubOpfs()
    await expect(
      openStorage({ order: ['opfs'], createWorker: asWorker(broken()) }),
    ).rejects.toMatchObject({ name: 'UnknownError' })
    await expect(openStorage({ order: ['opfs'] })).rejects.toThrow(/createWorker/)
    stubBrokenIdb()
    await expect(openStorage({ order: ['indexeddb'] })).rejects.toMatchObject({
      name: 'SecurityError',
    })
  })

  it('never falls back to memory unless it is listed', async () => {
    stubOpfs()
    stubBrokenIdb()
    await expect(openStorage({ createWorker: asWorker(broken()) })).rejects.toThrow(
      /No storage backend could be opened \(opfs: .*no OPFS.*; indexeddb: .*blocked/,
    )
  })

  it('rejects with every candidate error when all fail', async () => {
    stubBrokenIdb()
    const error = await openStorage({ order: ['opfs', 'indexeddb'] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect((error as AggregateError).errors[1]).toMatchObject({
      name: 'SecurityError',
    })
  })

  it('rejects an unknown backend or an empty order', async () => {
    await expect(openStorage({ order: ['nope' as never] })).rejects.toThrow(
      /Unknown storage backend/,
    )
    await expect(openStorage({ order: [] })).rejects.toThrow(/at least one backend/)
  })

  it('passes `directory` to IndexedDB', async () => {
    let name = ''
    vi.stubGlobal('indexedDB', {
      open(dbName: string) {
        name = dbName
        const req: Record<string, unknown> = {}
        queueMicrotask(() => {
          req.error = new DOMException('blocked', 'SecurityError')
          ;(req.onerror as () => void)()
        })
        return req
      },
    })
    await openStorage({ order: ['indexeddb', 'memory'], directory: 'mine' })
    expect(name).toBe('mine')
  })
})
