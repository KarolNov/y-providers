import type { Storage } from './byte-file-storage.js'
import {
  RECORD_SNAPSHOT,
  RECORD_UPDATE,
  decodeSnapshot,
  encodeRecord,
  encodeSnapshot,
  parseLog,
  type ParsedLog,
} from './log.js'
import type { DocumentStore } from './types.js'
import { assertUpdate } from './update.js'
import type { UpdateCodec } from './yjs.js'

/** Where the active log file is. `bytes` is its length on storage. */
export interface LogPosition {
  slot: 0 | 1
  generation: number
  records: number
  bytes: number
}

const DEFAULT_MAX_RECORDS = 500
const DEFAULT_MAX_BYTES = 1024 * 1024

export interface ByteFileLogOptions {
  /** `full` once the active log holds this many records. Default 500. */
  maxRecords?: number
  /** `full` once the active log exceeds this many bytes. Default 1 MiB. */
  maxBytes?: number
}

/** What the core log needs besides its options: the entry's Yjs functions. */
export interface WithYjs<Y> {
  yjs: Y
}

/**
 * One document's CRC log on a byte-file `Storage`, with crash-safe compaction.
 *
 * Two slot files per document (`<name>.0.ylog`, `<name>.1.ylog`). Each starts
 * with a snapshot record carrying a generation number. Compaction writes the
 * full state into the *other* slot with generation + 1, then deletes the old
 * one. A crash at any point leaves at least one slot whose first record is
 * intact, and on load the valid slot with the highest generation wins. This
 * needs no atomic rename, which OPFS does not offer everywhere.
 *
 * The log does not lock: callers hold a mutual exclusion over the document
 * while they use it. `ByteFileStore` does that and implements the shared
 * contract on top; `OpfsPersistence` uses the log directly because it keeps
 * its own lock, its position for tab broadcast, and the live doc.
 */
export class ByteFileLog {
  private slot: 0 | 1 = 0
  private generation = 0
  private records = 0
  private bytes = 0
  private readonly maxRecords: number
  private readonly maxBytes: number
  /** Whether `position` describes a file that was read or written by this log. */
  private known = false
  /** After a failed automatic compaction: the log size at which to try again. */
  private retry: { generation: number; bytes: number } | null = null
  private readonly yjs: UpdateCodec

  constructor(
    private readonly storage: Storage,
    readonly name: string,
    options: ByteFileLogOptions & WithYjs<UpdateCodec>,
  ) {
    this.yjs = options.yjs
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  private file(slot: number) {
    return `${encodeURIComponent(this.name)}.${slot}.ylog`
  }

  get position(): LogPosition {
    return {
      slot: this.slot,
      generation: this.generation,
      records: this.records,
      bytes: this.bytes,
    }
  }

  /** Whether the log has read or created its file, so `isStale` means something. */
  get loaded() {
    return this.known
  }

  /** The active log has grown past `maxRecords` or `maxBytes`: time to compact. */
  get full() {
    return this.records >= this.maxRecords || this.bytes >= this.maxBytes
  }

  /** Take over a position another writer reported. The caller checks that it continues exactly from ours. */
  adopt(position: LogPosition) {
    this.slot = position.slot
    this.generation = position.generation
    this.records = position.records
    this.bytes = position.bytes
  }

  private async scan() {
    const slots = await Promise.all(
      [0, 1].map(async (s) => {
        const bytes = await this.storage.read(this.file(s))
        if (!bytes) return null
        const parsed = parseLog(bytes)
        const first = parsed.records[0]
        if (!first || first.type !== RECORD_SNAPSHOT) return null
        return {
          slot: s as 0 | 1,
          parsed,
          generation: decodeSnapshot(first.payload).generation,
          bytes,
        }
      }),
    )
    return slots.filter((s) => s !== null).sort((a, b) => b.generation - a.generation)[0] ?? null
  }

  private static updates(parsed: ParsedLog) {
    const out: Uint8Array[] = []
    for (const record of parsed.records) {
      if (record.type === RECORD_SNAPSHOT) out.push(decodeSnapshot(record.payload).update)
      else if (record.type === RECORD_UPDATE) out.push(record.payload)
    }
    return out
  }

  /**
   * Read the newest valid slot and adopt its position. Returns its updates, in
   * log order, or null when no document is stored. Applying updates twice is
   * harmless, so a resync simply replays the whole log.
   */
  async load(): Promise<Uint8Array[] | null> {
    const best = await this.scan()
    if (!best) return null
    // Drop a torn tail, otherwise later appends would land after garbage and
    // be unreachable on the next load. Also drop the stale other slot.
    if (best.parsed.validLength < best.bytes.length) {
      await this.storage.write(
        this.file(best.slot),
        best.bytes.subarray(0, best.parsed.validLength),
      )
    }
    await this.storage.remove(this.file(best.slot === 0 ? 1 : 0))
    this.slot = best.slot
    this.generation = best.generation
    this.records = best.parsed.records.length
    this.bytes = best.parsed.validLength
    this.known = true
    return ByteFileLog.updates(best.parsed)
  }

  /** Start a document with `state` as its first snapshot. Replaces anything stored. */
  async create(state: Uint8Array) {
    const snapshot = encodeSnapshot(1, state)
    await this.storage.write(this.file(0), snapshot)
    await this.storage.remove(this.file(1))
    this.slot = 0
    this.generation = 1
    this.records = 1
    this.bytes = snapshot.length
    this.known = true
  }

  /** Whether the active file is not exactly what this log left, so another writer touched it. */
  async isStale() {
    return (await this.storage.size(this.file(this.slot))) !== this.bytes
  }

  /** Append one update record. Resolves with the record's length on storage. */
  async append(update: Uint8Array) {
    const record = encodeRecord(RECORD_UPDATE, update)
    await this.storage.append(this.file(this.slot), record)
    return this.appended(record)
  }

  /**
   * Append one update record unless the log `isStale`. Resolves with the
   * record's length, or null when another writer touched the file: nothing was
   * written, and the caller loads before appending. One storage call where the
   * storage has `appendIfSize`.
   */
  async appendIfFresh(update: Uint8Array) {
    const record = encodeRecord(RECORD_UPDATE, update)
    const file = this.file(this.slot)
    if (this.storage.appendIfSize) {
      if (!(await this.storage.appendIfSize(file, record, this.bytes))) return null
    } else {
      if (await this.isStale()) return null
      await this.storage.append(file, record)
    }
    return this.appended(record)
  }

  private appended(record: Uint8Array) {
    this.records++
    this.bytes += record.length
    return record.length
  }

  /**
   * Replace the log by one snapshot of `state`, or of what is stored when
   * `state` is not given.
   */
  async compact(state?: Uint8Array) {
    if (!state) {
      // The active slot only: after a failed compaction the other slot can hold an
      // older state at a higher generation, and merging that would drop what was
      // appended since.
      const bytes = await this.storage.read(this.file(this.slot))
      if (!bytes) throw new Error('nothing to compact')
      state = this.yjs.mergeUpdatesV2(ByteFileLog.updates(parseLog(bytes)))
    }
    const next = this.slot === 0 ? 1 : 0
    const generation = this.generation + 1
    const snapshot = encodeSnapshot(generation, state)
    await this.storage.write(this.file(next), snapshot)
    try {
      await this.storage.remove(this.file(this.slot))
    } catch (e) {
      // Left behind, the new slot would win the next load at a higher generation
      // while appends keep going to the old one. Make the old slot the only one.
      await this.storage.remove(this.file(next)).catch(() => {})
      throw e
    }
    this.slot = next
    this.generation = generation
    this.records = 1
    this.bytes = snapshot.length
  }

  /**
   * Compacts when the log is `full`. A failure (out of space for the snapshot)
   * is thrown to the caller, who already has the update stored: the next
   * attempt waits until the log has grown by another quarter of `maxBytes`
   * instead of rewriting the snapshot on every append. `state` is only called
   * when a compaction runs; without it the stored log is merged. Resolves
   * with whether a compaction happened.
   */
  async autoCompact(state?: () => Uint8Array) {
    if (!this.full) return false
    const { generation, bytes } = this.position
    const retry = this.retry
    if (retry && retry.generation === generation && bytes < retry.bytes) return false
    try {
      await this.compact(state?.())
    } catch (e) {
      this.retry = { generation, bytes: bytes + this.maxBytes / 4 }
      throw e
    }
    this.retry = null
    return true
  }

  /** Delete both slot files. */
  async remove() {
    await this.storage.remove(this.file(0))
    await this.storage.remove(this.file(1))
    this.known = false
  }
}

export type LockFn = <T>(name: string, fn: () => Promise<T>) => Promise<T>

/** The Web Locks name that guards one document's files, across tabs. */
export const byteFileLockName = (name: string) => `y-modern:${name}`

const noLock: LockFn = (_name, fn) => fn()

/**
 * Web Locks (`navigator.locks`), or no locking where that is unavailable
 * (Node). Pass it as `lock` to coordinate tabs of one browser. For writers in
 * several processes or machines, pass any `LockFn` that takes a distributed
 * lock (Redlock, a database advisory lock, a lockfile) around `fn`.
 */
export const webLocks: LockFn = (name, fn) =>
  typeof navigator !== 'undefined' && navigator.locks
    ? (navigator.locks.request(name, fn) as Promise<never>)
    : fn()

// Keyed by scope and name; a Storage without a scope shares one key per name, which only over-serialises.
const tails = new Map<string, Promise<void>>()

/** Runs `fn` after everything queued under `key` before it. */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(fn)
  const tail = run.then(
    () => {},
    () => {},
  )
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}

export interface ByteFileStoreOptions extends ByteFileLogOptions {
  /**
   * Mutual exclusion per document across tabs and processes: run `fn` while
   * holding a lock named `name`. Writers in one process are always serialised
   * without it; writers in several tabs or processes sharing one `Storage`
   * need it, or an append can be lost while another writer compacts. Use
   * `webLocks` for tabs. Default: none.
   */
  lock?: LockFn
  /** How many documents' log positions to remember. Default 100. */
  maxCachedDocuments?: number
  /** Compaction runs after the append is stored, so its failure is reported here, not thrown. */
  onError?: (error: unknown) => void
}

/** How many documents' log positions a store remembers by default. */
const DEFAULT_MAX_CACHED_DOCUMENTS = 100

/**
 * Implements the shared `DocumentStore` over a byte-file `Storage` (OPFS, Node
 * fs, IndexedDB, memory), keeping the CRC log format and generation slots, and
 * compacting by itself once a log passes `maxRecords` or `maxBytes`. It owns
 * the `Storage`: `close()` closes it.
 */
export class ByteFileStore implements DocumentStore {
  /** Least recently used first. A forgotten position costs one re-read, nothing else. */
  private readonly logs = new Map<string, ByteFileLog>()
  private readonly lock: LockFn
  private readonly onError: (error: unknown) => void
  private readonly maxCached: number

  constructor(
    private readonly storage: Storage,
    private readonly options: ByteFileStoreOptions & WithYjs<UpdateCodec>,
  ) {
    this.lock = options.lock ?? noLock
    this.onError = options.onError ?? ((e) => console.error('[y-append-log]', e))
    this.maxCached = options.maxCachedDocuments ?? DEFAULT_MAX_CACHED_DOCUMENTS
  }

  /** How many documents' positions are remembered right now. */
  get cachedDocuments() {
    return this.logs.size
  }

  private locked<T>(name: string, fn: () => Promise<T>) {
    return serial(`${this.storage.scope ?? ''}\0${name}`, () =>
      this.lock(byteFileLockName(name), fn),
    )
  }

  private log(name: string) {
    let log = this.logs.get(name)
    if (log) this.logs.delete(name)
    else log = new ByteFileLog(this.storage, name, this.options)
    this.logs.set(name, log)
    if (this.logs.size > this.maxCached) this.logs.delete(this.logs.keys().next().value!)
    return log
  }

  load(name: string) {
    return this.locked(name, () => this.log(name).load())
  }

  append(name: string, update: Uint8Array) {
    return this.locked(name, async () => {
      assertUpdate(this.options.yjs, update)
      const log = this.log(name)
      if (!log.loaded || (await log.appendIfFresh(update)) === null) {
        if (!(await log.load())) {
          await log.create(update)
          return
        }
        await log.append(update)
      }
      try {
        await log.autoCompact()
      } catch (e) {
        this.onError(e)
      }
    })
  }

  delete(name: string) {
    return this.locked(name, async () => {
      await this.log(name).remove()
      this.logs.delete(name)
    })
  }

  close() {
    return this.storage.close?.()
  }
}
