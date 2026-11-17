import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { DocumentStore } from 'y-append-log/core'
import type {
  AwarenessChanges,
  SyncYjs,
  TransportAwareness,
  TransportDoc,
  TransportYjs,
} from '../yjs.js'
import type { Link } from '../link.js'
import {
  LOCAL_VERSIONS,
  MSG_AWARENESS,
  MSG_LEAVE,
  MSG_PING,
  MSG_PONG,
  MSG_SYNC,
  decodeFrame,
  decodeHello,
  encodeFrame,
  encodeHello,
  negotiateVersion,
} from '../protocol.js'
import { readSyncMessage, writeSyncStep1, writeUpdate } from '../sync.js'

const EMPTY = new Uint8Array(0)

export type { DocumentStore } from 'y-append-log/core'
export type { Link } from '../link.js'

export interface SyncServerOptions {
  /**
   * Where documents survive restarts: any `DocumentStore` from
   * `y-append-log`. The server calls `load` once when a document is first
   * opened and `append` with every update it accepts, in order.
   */
  storage?: DocumentStore
  /**
   * Decide whether a connection may open a document. `context` is whatever the
   * adapter knows about the connection (the HTTP request for WebSocket, the
   * session for WebTransport). Denied connections are told nothing: their
   * frames for that document are ignored.
   */
  authorize?: (doc: string, context: unknown) => boolean | Promise<boolean>
  /**
   * Free a document this many ms after its last connection left. Default 30000
   * with `storage`, never without it (the memory is the only copy). Set it
   * without `storage` to bound memory: a freed document is gone from the
   * server, and comes back only from a client that still holds it and syncs
   * again; a client that has none gets an empty document.
   */
  evictAfter?: number
  /** Close a connection that has not sent its hello (the protocol handshake) after this many ms. Default 10000, 0 waits forever. */
  helloTimeout?: number
  onError?: (error: unknown) => void
}

const MAX_DOC_NAME = 1024
/** A server timer must not keep a process alive on its own (Node; elsewhere a no-op). */
function unref<T>(timer: T): T {
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}

/** How long a rejected client gets to read the server's hello before the server closes the connection. */
const REJECT_GRACE = 2000
const LOAD_ORIGIN = Symbol('load')

class Room<D extends TransportDoc, A extends TransportAwareness> {
  readonly doc: D
  readonly awareness: A
  readonly links = new Set<Link>()
  /** Awareness client ids each connection has announced, to remove on disconnect. */
  readonly controlled = new Map<Link, Set<number>>()
  evictTimer: ReturnType<typeof setTimeout> | null = null
  ready!: Promise<void>
  writes: Promise<unknown> = Promise.resolve()
  constructor(
    readonly name: string,
    yjs: TransportYjs<D, A>,
  ) {
    this.doc = yjs.createDoc()
    this.awareness = yjs.createAwareness(this.doc)
    this.awareness.setLocalState(null)
  }
}

/**
 * The transport-independent part of the server: documents ("rooms") and the
 * links connected to them. Hand it a `Link` per connection, from
 * `y-transport/server/ws` or `/server/webtransport` or your own.
 */
export class SyncServer<
  D extends TransportDoc = TransportDoc,
  A extends TransportAwareness = TransportAwareness,
> {
  private readonly rooms = new Map<string, Room<D, A>>()
  private readonly links = new Set<Link>()
  /** Documents being written out and freed; reopening one waits for that to finish. */
  private readonly evicting = new Map<string, Promise<void>>()
  private readonly options: SyncServerOptions
  private readonly yjs: TransportYjs<D, A>
  private readonly onError: (error: unknown) => void
  private closed = false

  constructor(options: SyncServerOptions & { yjs: TransportYjs<D, A> }) {
    this.options = options
    this.yjs = options.yjs
    this.onError = options.onError ?? ((e) => console.error('[y-transport/server]', e))
  }

  /** Names of the documents currently in memory. */
  get documents(): string[] {
    return [...this.rooms.keys()]
  }

  /** Start serving a connection. */
  accept(link: Link, context?: unknown): void {
    if (this.closed) return void link.close()
    this.links.add(link)
    const joined = new Map<string, Room<D, A> | null>()
    const pending = new Map<string, Promise<Room<D, A> | null>>()
    let chain: Promise<unknown> = Promise.resolve()
    let greeted = false
    const helloTimeout = this.options.helloTimeout ?? 10_000
    const helloTimer = helloTimeout ? unref(setTimeout(() => link.close(), helloTimeout)) : null

    const join = (name: string): Promise<Room<D, A> | null> => {
      let p = pending.get(name)
      if (!p) {
        p = this.join(link, name, context).then((room) => {
          joined.set(name, room)
          return room
        })
        pending.set(name, p)
      }
      return p
    }

    // Frames from one link are handled strictly in order, even while a document is still loading.
    link.onFrame = (data) => {
      if (!greeted) {
        if (helloTimer) clearTimeout(helloTimer)
        return void this.greet(link, data, () => (greeted = true))
      }
      chain = chain
        .then(async () => {
          const frame = decodeFrame(data)
          if (!frame || frame.doc.length > MAX_DOC_NAME) return
          if (frame.type === MSG_PING) return void link.send(encodeFrame('', MSG_PONG, EMPTY))
          if (frame.type === MSG_LEAVE) {
            const room = joined.get(frame.doc) ?? (await pending.get(frame.doc))
            joined.delete(frame.doc)
            pending.delete(frame.doc)
            if (room) this.leave(room, link)
            return
          }
          const room = joined.has(frame.doc) ? joined.get(frame.doc)! : await join(frame.doc)
          if (room) this.handle(room, link, frame.type, frame.payload)
        })
        .catch(this.onError)
    }

    void link.closed.then(() => {
      if (helloTimer) clearTimeout(helloTimer)
      this.links.delete(link)
      chain = chain.then(() => {
        for (const room of joined.values()) if (room) this.leave(room, link)
      })
    })
  }

  /** Disconnect everyone, flush storage and free every document. */
  async close(): Promise<void> {
    this.closed = true
    for (const link of this.links) link.close()
    await Promise.all([...this.rooms.values()].map((room) => this.evict(room)))
    await this.options.storage?.close?.()
  }

  /**
   * The first message must be the client's hello. The server answers with its
   * own either way, so the client can tell the user which versions each side
   * speaks, and closes the connection if they have none in common.
   */
  private greet(link: Link, data: Uint8Array, accepted: () => void) {
    const remote = decodeHello(data)
    if (!remote) return void link.close()
    link.send(encodeHello())
    if (negotiateVersion(LOCAL_VERSIONS, remote) !== null) return accepted()
    // The client closes on reading our hello; this is for one that does not.
    const timer = unref(setTimeout(() => link.close(), REJECT_GRACE))
    void link.closed.then(() => clearTimeout(timer))
  }

  private async join(link: Link, name: string, context: unknown): Promise<Room<D, A> | null> {
    if (this.closed) return null
    try {
      if (this.options.authorize && !(await this.options.authorize(name, context))) return null
    } catch (error) {
      this.onError(error)
      return null
    }
    if (this.closed) return null
    const room = this.room(name)
    await room.ready
    if (room.evictTimer) {
      clearTimeout(room.evictTimer)
      room.evictTimer = null
    }
    room.links.add(link)
    // Open the exchange from our side too: the client sent step 1, now ask for what the server lacks.
    const e = encoding.createEncoder()
    writeSyncStep1(e, room.doc, this.yjs)
    link.send(encodeFrame(name, MSG_SYNC, encoding.toUint8Array(e)))
    const states = [...room.awareness.getStates().keys()]
    if (states.length) {
      link.send(
        encodeFrame(name, MSG_AWARENESS, this.yjs.encodeAwarenessUpdate(room.awareness, states)),
      )
    }
    return room
  }

  private room(name: string): Room<D, A> {
    let room = this.rooms.get(name)
    if (room) return room
    room = new Room(name, this.yjs)
    this.rooms.set(name, room)
    const r = room
    const previous = this.evicting.get(name)
    room.ready = (async () => {
      // A previous copy may still be writing its last updates; loading before they land would miss them.
      await previous
      if (this.options.storage) applyStored(r.doc, await this.options.storage.load(name), this.yjs)
      // Attach after loading so the loaded state is not written straight back.
      r.doc.on('updateV2', (update: Uint8Array, origin: unknown) =>
        this.onUpdate(r, update, origin),
      )
      r.awareness.on('update', (changes: AwarenessChanges, origin: unknown) =>
        this.onAwareness(r, changes, origin),
      )
    })()
    room.ready.catch((error) => {
      this.onError(error)
      if (this.rooms.get(name) === r) this.rooms.delete(name)
    })
    return room
  }

  private handle(room: Room<D, A>, link: Link, type: number, payload: Uint8Array) {
    if (type === MSG_SYNC) {
      const reply = encoding.createEncoder()
      readSyncMessage(decoding.createDecoder(payload), reply, room.doc, link, this.yjs)
      if (encoding.length(reply) > 0)
        link.send(encodeFrame(room.name, MSG_SYNC, encoding.toUint8Array(reply)))
    } else if (type === MSG_AWARENESS) {
      this.yjs.applyAwarenessUpdate(room.awareness, payload, link)
    }
  }

  private onUpdate(room: Room<D, A>, update: Uint8Array, origin: unknown) {
    const e = encoding.createEncoder()
    writeUpdate(e, update)
    const frame = encodeFrame(room.name, MSG_SYNC, encoding.toUint8Array(e))
    for (const link of room.links) if (link !== origin) link.send(frame)
    const storage = this.options.storage
    if (storage && origin !== LOAD_ORIGIN) {
      room.writes = room.writes.then(() => storage.append(room.name, update)).catch(this.onError)
    }
  }

  private onAwareness(
    room: Room<D, A>,
    { added, updated, removed }: AwarenessChanges,
    origin: unknown,
  ) {
    const link = origin as Link
    const owned = room.controlled.get(link)
    if (room.links.has(link)) {
      const ids = owned ?? new Set<number>()
      for (const id of added) ids.add(id)
      for (const id of removed) ids.delete(id)
      if (!owned) room.controlled.set(link, ids)
    }
    const frame = encodeFrame(
      room.name,
      MSG_AWARENESS,
      this.yjs.encodeAwarenessUpdate(room.awareness, [...added, ...updated, ...removed]),
    )
    // Departures are not repeated, so they go reliably; the rest is renewed every 15s.
    const unreliable = removed.length === 0
    for (const other of room.links) if (other !== origin) other.send(frame, { unreliable })
  }

  private leave(room: Room<D, A>, link: Link) {
    room.links.delete(link)
    const owned = room.controlled.get(link)
    room.controlled.delete(link)
    if (owned?.size) this.yjs.removeAwarenessStates(room.awareness, [...owned], null)
    if (room.links.size === 0 && !this.closed) this.scheduleEviction(room)
  }

  private scheduleEviction(room: Room<D, A>) {
    const after = this.options.evictAfter ?? (this.options.storage ? 30_000 : Infinity)
    if (!Number.isFinite(after)) return
    room.evictTimer = unref(
      setTimeout(() => {
        room.evictTimer = null
        if (room.links.size === 0) void this.evict(room)
      }, after),
    )
  }

  private evict(room: Room<D, A>): Promise<void> {
    if (this.rooms.get(room.name) !== room) return this.evicting.get(room.name) ?? Promise.resolve()
    this.rooms.delete(room.name)
    if (room.evictTimer) clearTimeout(room.evictTimer)
    const done = (async () => {
      await room.ready.catch(() => {})
      await room.writes
      room.awareness.destroy()
      room.doc.destroy()
    })()
    this.evicting.set(room.name, done)
    void done.finally(() => {
      if (this.evicting.get(room.name) === done) this.evicting.delete(room.name)
    })
    return done
  }
}

function applyStored<D extends TransportDoc>(
  doc: D,
  updates: Uint8Array[] | null,
  yjs: SyncYjs<D>,
) {
  if (!updates) return
  doc.transact(() => {
    for (const update of updates) yjs.applyUpdateV2(doc, update, LOAD_ORIGIN)
  }, LOAD_ORIGIN)
}
