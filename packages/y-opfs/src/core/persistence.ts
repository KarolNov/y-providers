import {
  ByteFileLog,
  byteFileLockName,
  webLocks,
  type LockFn,
  type LogPosition,
  type Storage,
} from 'y-append-log/core'
import type { PersistenceDoc, PersistenceYjs } from './yjs.js'

export type { LockFn, LogPosition }

export interface PersistenceOptions {
  /** Compact once the active log holds this many records. Default 500. */
  maxRecords?: number
  /** Compact once the active log exceeds this many bytes. Default 1 MiB. */
  maxBytes?: number
  onError?: (error: unknown) => void
  /**
   * Mutual exclusion per document across tabs. Defaults to Web Locks
   * (`navigator.locks`), or no locking where that is unavailable (Node).
   */
  lock?: LockFn
  /**
   * Live sync between tabs. Each persisted update is broadcast so other tabs
   * with the same document apply it without waiting for a reload. Storage stays
   * the source of truth: a tab that misses a message repairs itself from it.
   * `true` (default) uses the global `BroadcastChannel` where it exists, `false`
   * turns it off, or pass a factory to supply your own channel.
   */
  broadcast?: boolean | ((channelName: string) => BroadcastChannelLike)
  /**
   * Observe what the persistence does: loads, flushes, compactions, re-reads
   * from storage and broadcasts sent and received. Meant for debugging and
   * status displays. Called synchronously; keep it cheap. If it throws, the
   * error goes to `onError` and persistence carries on.
   */
  onEvent?: (event: PersistenceEvent) => void
}

export type BroadcastKind = 'update' | 'changed' | 'compacted' | 'cleared'

/** Why the log was re-read after the initial load. */
export type ResyncReason = 'write' | 'message' | 'refresh' | 'compact'

/** `position` is where the log is once the event has happened. */
export type PersistenceEvent = { position: LogPosition } & (
  | { type: 'load' }
  | { type: 'flush'; updates: number; bytes: number }
  | { type: 'compact' }
  | { type: 'resync'; reason: ResyncReason }
  | { type: 'broadcast-sent'; kind: BroadcastKind }
  /** `adopted`: the message continued exactly from our position, so nothing was re-read. */
  | { type: 'broadcast-received'; kind: BroadcastKind; adopted: boolean }
  /**
   * The stored data was deleted by `clearData`. `remote` is true in the other
   * tabs, which have detached from their doc: it still holds content that is
   * no longer in storage, so discard it and open a fresh one.
   */
  | { type: 'cleared'; remote: boolean }
)

/** The subset of `BroadcastChannel` that is used. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void
  onmessage: ((event: { data: unknown }) => void) | null
  close(): void
  /** Node only: lets the process exit while the channel is open. */
  unref?(): void
}

/** Updates above this are not cloned to every tab; they get a "changed" signal and re-read instead. */
const MAX_BROADCAST_BYTES = 256 * 1024

/** Where a tab believes the log is. A message only applies cleanly if it starts from there. */
type Position = LogPosition

type Message =
  | { kind: 'update'; from: Position; to: Position; update: Uint8Array }
  | { kind: 'changed'; from: Position; to: Position }
  | { kind: 'compacted'; from: Position; to: Position }
  | { kind: 'cleared' }

const isMessage = (m: unknown): m is Message =>
  typeof m === 'object' &&
  m !== null &&
  ['update', 'changed', 'compacted', 'cleared'].includes((m as Message).kind)

/**
 * Persists a Y.Doc as an append-only log with crash-safe compaction. The log
 * format and its generation slots live in `y-append-log` (`ByteFileLog`);
 * this class adds the per-tab lock, tab broadcast, change detection and events
 * on top of it.
 */
export class OpfsPersistence<D extends PersistenceDoc = PersistenceDoc> {
  readonly doc: D
  readonly name: string
  readonly whenSynced: Promise<this>
  synced = false

  private readonly storage: Storage
  private readonly log: ByteFileLog
  private readonly onError: (error: unknown) => void
  private readonly lock: LockFn
  private readonly onEvent: ((event: PersistenceEvent) => void) | undefined
  private readonly yjs: PersistenceYjs<D>

  private pending: Uint8Array[] = []
  private chain: Promise<unknown>
  private destroyed = false
  private channel: BroadcastChannelLike | null = null
  private refreshQueued = false

  constructor(
    name: string,
    doc: D,
    storage: Storage,
    options: PersistenceOptions & { yjs: PersistenceYjs<D> },
  ) {
    this.yjs = options.yjs
    this.name = name
    this.doc = doc
    this.storage = storage
    this.log = new ByteFileLog(storage, name, {
      maxRecords: options.maxRecords,
      maxBytes: options.maxBytes,
      yjs: options.yjs,
    })
    this.lock = options.lock ?? webLocks
    this.onEvent = options.onEvent
    this.onError = options.onError ?? ((e) => console.error('[y-opfs]', e))

    // Attached before load finishes so edits made while loading are not lost;
    // they queue behind the load on the same chain.
    doc.on('updateV2', this.handleUpdate)
    doc.on('destroy', this.handleDestroy)
    this.openChannel(options.broadcast ?? true)

    this.chain = this.load()
    this.whenSynced = this.chain.then(() => {
      this.synced = true
      return this
    })
  }

  private handleUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.destroyed) return
    this.pending.push(update)
    this.enqueue(() => this.flushPending())
  }

  private handleDestroy = () => {
    void this.destroy()
  }

  private openChannel(option: NonNullable<PersistenceOptions['broadcast']>) {
    const make =
      typeof option === 'function'
        ? option
        : option && typeof BroadcastChannel !== 'undefined'
          ? (n: string) => new BroadcastChannel(n) as BroadcastChannelLike
          : null
    if (!make) return
    this.channel = make(`y-opfs:${this.storage.scope ?? ''}:${this.name}`)
    this.channel.unref?.()
    this.channel.onmessage = this.handleMessage
  }

  private get position(): Position {
    return this.log.position
  }

  private emit(event: { type: PersistenceEvent['type'] } & Record<string, unknown>) {
    if (!this.onEvent) return
    try {
      this.onEvent({ ...event, position: this.position } as PersistenceEvent)
    } catch (e) {
      this.onError(e)
    }
  }

  private broadcast(message: Message) {
    if (!this.channel) return
    try {
      this.channel.postMessage(message)
    } catch (e) {
      this.onError(e)
      return
    }
    this.emit({ type: 'broadcast-sent', kind: message.kind })
  }

  /**
   * Another tab persisted something. Apply it with ourselves as the origin so
   * it is neither written nor broadcast again. If the message continues exactly
   * from where we think the log is, adopt its position and the next write needs
   * no resync; otherwise we missed something (or it arrived out of order), so
   * re-read from storage.
   */
  private handleMessage = (event: { data: unknown }) => {
    const message = event.data
    if (this.destroyed || !isMessage(message)) return
    if (message.kind === 'cleared') {
      this.emit({ type: 'broadcast-received', kind: 'cleared', adopted: false })
      this.detach()
      this.emit({ type: 'cleared', remote: true })
      return
    }
    if (message.kind === 'update') this.yjs.applyUpdateV2(this.doc, message.update, this)
    if (!this.synced) {
      // the initial load reads everything the sender wrote
      this.emit({ type: 'broadcast-received', kind: message.kind, adopted: false })
      return
    }
    const { from, to } = message
    const here = this.position
    const inSync =
      from.slot === here.slot && from.generation === here.generation && from.bytes === here.bytes
    const adopted = inSync && message.kind !== 'changed'
    if (adopted) {
      this.log.adopt(to)
    } else if (!this.refreshQueued) {
      this.refreshQueued = true
      this.enqueue(async () => {
        this.refreshQueued = false
        await this.withLock(() => this.syncIfStale('message'))
      })
    }
    this.emit({ type: 'broadcast-received', kind: message.kind, adopted })
  }

  private enqueue(task: () => Promise<void>) {
    this.chain = this.chain.then(task).catch((e) => this.onError(e))
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock(byteFileLockName(this.name), fn)
  }

  /**
   * Read the newest valid slot into the doc and adopt its position. Must run
   * under the lock. Used for the initial load and whenever another writer
   * (another tab) changed the files since we last touched them. Applying
   * updates twice is harmless, so resync simply replays the whole log.
   */
  private async sync() {
    const updates = await this.log.load()
    if (!updates) {
      // Fresh doc, or another tab cleared the data: persist whatever we hold.
      await this.log.create(this.yjs.encodeStateAsUpdateV2(this.doc))
      return
    }
    this.doc.transact(() => {
      for (const update of updates) this.yjs.applyUpdateV2(this.doc, update, this)
    }, this)
  }

  private load() {
    return this.withLock(async () => {
      await this.sync()
      this.emit({ type: 'load' })
    })
  }

  /** Under the lock: if the active file is not exactly what we left, someone else wrote. */
  private async syncIfStale(reason: ResyncReason) {
    if (!(await this.log.isStale())) return
    await this.sync()
    this.emit({ type: 'resync', reason })
  }

  /** Coalesces everything queued since the last flush into a single record. */
  private flushPending() {
    if (this.pending.length === 0) return Promise.resolve()
    return this.withLock(async () => {
      if (this.pending.length === 0) return
      const batch = this.pending
      this.pending = []
      const update = batch.length === 1 ? batch[0]! : this.yjs.mergeUpdatesV2(batch)
      let from = this.position
      let bytes: number
      try {
        // The staleness check and the append are one storage call; only when
        // another tab wrote since do we re-read, then append.
        const appended = await this.log.appendIfFresh(update)
        if (appended === null) {
          await this.sync()
          this.emit({ type: 'resync', reason: 'write' })
          from = this.position
          bytes = await this.log.append(update)
        } else bytes = appended
      } catch (e) {
        this.pending = batch.concat(this.pending)
        throw e
      }
      this.emit({ type: 'flush', updates: batch.length, bytes })
      this.broadcast(
        update.length <= MAX_BROADCAST_BYTES
          ? { kind: 'update', from, to: this.position, update }
          : { kind: 'changed', from, to: this.position },
      )
      await this.autoCompact()
    })
  }

  /**
   * Under the lock. The update is already stored, so a failed compaction (out
   * of space for the snapshot) does not fail the flush: it goes to `onError`
   * and the log keeps growing; see `ByteFileLog.autoCompact` for the back-off.
   */
  private async autoCompact() {
    const from = this.position
    try {
      if (!(await this.log.autoCompact(() => this.yjs.encodeStateAsUpdateV2(this.doc)))) return
    } catch (e) {
      this.onError(e)
      return
    }
    this.emit({ type: 'compact' })
    this.broadcast({ kind: 'compacted', from, to: this.position })
  }

  /** Under the lock. */
  private async compactNow() {
    const from = this.position
    await this.log.compact(this.yjs.encodeStateAsUpdateV2(this.doc))
    this.emit({ type: 'compact' })
    this.broadcast({ kind: 'compacted', from, to: this.position })
  }

  /** Pull in whatever other tabs have persisted since we last looked. Resolves once applied. */
  refresh(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.enqueue(async () => {
        try {
          await this.withLock(() => this.syncIfStale('refresh'))
          resolve()
        } catch (e) {
          reject(e)
          throw e
        }
      })
    })
  }

  /** Resolves once everything queued so far is durable. */
  flush(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.enqueue(async () => {
        try {
          await this.flushPending()
          resolve()
        } catch (e) {
          reject(e)
          throw e
        }
      })
    })
  }

  /** Force a compaction now. */
  compact(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.enqueue(async () => {
        try {
          await this.flushPending()
          await this.withLock(async () => {
            await this.syncIfStale('compact')
            await this.compactNow()
          })
          resolve()
        } catch (e) {
          reject(e)
          throw e
        }
      })
    })
  }

  /**
   * Delete this document's persisted data and detach. Other tabs on the same
   * broadcast channel are told: they detach too and emit `cleared` with
   * `remote: true`, because their doc holds content that is no longer in
   * storage and must not be written back. A tab that does not get the message
   * (broadcast off, or frozen) keeps the old behaviour: it persists its own
   * state again the next time it writes. Writes already in flight in another
   * tab when this runs can survive.
   */
  async clearData(): Promise<void> {
    if (!this.destroyed) {
      await this.flush().catch(() => {})
      this.detach({ keepChannel: true })
    }
    await this.withLock(async () => {
      await this.log.remove()
    })
    if (this.channel) {
      this.broadcast({ kind: 'cleared' })
      this.channel.close()
      this.channel = null
    }
    this.emit({ type: 'cleared', remote: false })
  }

  /** Flush, then detach from the doc. Does not close the shared storage. */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    await this.flush().catch(() => {})
    this.detach()
  }

  private detach({ keepChannel = false } = {}) {
    this.destroyed = true
    this.pending = []
    if (!keepChannel) {
      this.channel?.close()
      this.channel = null
    }
    this.doc.off('updateV2', this.handleUpdate)
    this.doc.off('destroy', this.handleDestroy)
  }
}
