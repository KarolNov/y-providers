import { IdbStorage } from './idb.js'
import { WorkerStorage } from './worker-client.js'
import { MemoryStorage, type Storage } from 'y-append-log/core'

/**
 * Whether OPFS persistence can work from here. On the main thread
 * `createSyncAccessHandle` is not exposed, so we check for what the worker
 * will need: the directory API plus the ability to spawn a Worker. Inside a
 * worker we check for the handle API itself.
 */
export function opfsSupported(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function')
    return false
  if (typeof FileSystemFileHandle === 'undefined') return false
  const inWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope
  return inWorker
    ? 'createSyncAccessHandle' in FileSystemFileHandle.prototype
    : typeof Worker !== 'undefined'
}

/** A backend `openStorage` can try. */
export type StorageBackend = 'opfs' | 'indexeddb' | 'memory'

export interface OpenStorageOptions {
  /**
   * Backends to try, in order; the first that opens serves the whole session.
   * Default `['opfs', 'indexeddb']`. A one-element order pins that backend and
   * rejects with its error if it fails. `'memory'` keeps nothing across reloads
   * and is only used when listed.
   */
  order?: readonly StorageBackend[]
  /** Create the OPFS worker. Needed so bundlers see the worker URL statically. Without it OPFS is skipped. */
  createWorker?: () => Worker
  /** IndexedDB database name for the IndexedDB backend. */
  directory?: string
}

export interface OpenedStorage {
  storage: Storage
  /** The backend that opened. Fixed for the session: there is no failover after open. */
  active: StorageBackend
  /** Candidates tried before `active`, with the error each failed with. */
  skipped: { backend: StorageBackend; error: unknown }[]
}

const PROBE = '.y-opfs-probe'
/** How long a candidate may take to answer the probe before it counts as failed. */
const PROBE_TIMEOUT_MS = 10_000

/**
 * Opens the first backend in `order` that works, by default OPFS via a worker,
 * else IndexedDB. Each candidate is really opened and asked for the size of a
 * file that does not exist, so a backend whose API exists but throws on open
 * (e.g. OPFS in WebKit's private windows) is skipped. Rejects if every
 * candidate fails.
 *
 *   const { storage, active } = await openStorage({
 *     createWorker: () => new Worker(new URL('y-opfs/worker', import.meta.url), { type: 'module' }),
 *   })
 *   await openStorage({ order: ['indexeddb'] })
 */
export async function openStorage(options: OpenStorageOptions = {}): Promise<OpenedStorage> {
  const order = options.order ?? ['opfs', 'indexeddb']
  if (order.length === 0) throw new Error('openStorage needs at least one backend in `order`')
  for (const backend of order) {
    if (backend !== 'opfs' && backend !== 'indexeddb' && backend !== 'memory')
      throw new Error(`Unknown storage backend: ${String(backend)}`)
  }
  const skipped: OpenedStorage['skipped'] = []
  for (const backend of order) {
    try {
      return { storage: await open(backend, options), active: backend, skipped }
    } catch (error) {
      if (order.length === 1) throw error
      skipped.push({ backend, error })
    }
  }
  throw new AggregateError(
    skipped.map((s) => s.error),
    `No storage backend could be opened (${skipped.map((s) => `${s.backend}: ${String(s.error)}`).join('; ')})`,
  )
}

async function open(backend: StorageBackend, options: OpenStorageOptions): Promise<Storage> {
  if (backend === 'memory') return new MemoryStorage()
  let storage: Storage
  if (backend === 'indexeddb') {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not supported here')
    storage = new IdbStorage(options.directory)
  } else {
    if (!options.createWorker) throw new Error("the 'opfs' backend needs a createWorker function")
    if (!opfsSupported()) throw new Error('OPFS is not supported here')
    storage = new WorkerStorage(options.createWorker())
  }
  try {
    try {
      await probe(storage)
    } catch {
      // One retry, so a transient failure does not strand existing data in this backend
      await probe(storage)
    }
    return storage
  } catch (error) {
    try {
      await storage.close?.()
    } catch {
      // abandoned either way
    }
    throw error
  }
}

/** `size()` of a file that does not exist, failing if it takes longer than `PROBE_TIMEOUT_MS`. */
async function probe(storage: Storage) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      storage.size(PROBE),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`storage did not answer within ${PROBE_TIMEOUT_MS} ms`)),
          PROBE_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
