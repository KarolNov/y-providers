import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { Link } from './link.js'
import { MSG_AWARENESS, MSG_LEAVE, MSG_SYNC } from './protocol.js'
import { SYNC_STEP2, readSyncMessage, writeSyncStep1, writeUpdate } from './sync.js'
import type { Transport } from './transport.js'
import type { AwarenessChanges, TransportAwareness, TransportDoc, TransportYjs } from './yjs.js'

export interface SyncProviderOptions<A = TransportAwareness> {
  /** Presence for this document. Defaults to a new `Awareness`; `false` turns presence off. */
  awareness?: A | false
  /** Called when the document becomes synced with the server, and when the connection drops. */
  onSyncedChange?: (synced: boolean) => void
}

/**
 * Syncs a Y.Doc with a sync server over a shared `Transport`. Edits made while
 * offline are not queued: when the connection comes back both sides exchange
 * what the other is missing, which is what Yjs does anyway.
 */
export class SyncProvider<
  D extends TransportDoc = TransportDoc,
  A extends TransportAwareness = TransportAwareness,
> {
  readonly doc: D
  readonly name: string
  readonly awareness: A | null
  readonly whenSynced: Promise<this>
  /** True from the server's reply to our handshake until the connection drops. */
  synced = false

  private readonly transport: Transport
  private readonly yjs: TransportYjs<D, A>
  private readonly onSyncedChange: ((synced: boolean) => void) | undefined
  private readonly detach: () => void
  private readonly ownsAwareness: boolean
  /** Set while re-announcing presence on a new connection, which must not be lost. */
  private announcing = false
  private link: Link | null = null
  private destroyed = false
  private resolveSynced!: (provider: this) => void

  constructor(
    name: string,
    doc: D,
    transport: Transport,
    options: SyncProviderOptions<A> & { yjs: TransportYjs<D, A> },
  ) {
    this.yjs = options.yjs
    this.name = name
    this.doc = doc
    this.transport = transport
    this.onSyncedChange = options.onSyncedChange
    this.awareness =
      options.awareness === false ? null : (options.awareness ?? this.yjs.createAwareness(doc))
    this.ownsAwareness = this.awareness !== null && options.awareness === undefined
    this.whenSynced = new Promise((resolve) => (this.resolveSynced = resolve))

    doc.on('updateV2', this.handleUpdate)
    doc.on('destroy', this.destroy)
    this.awareness?.on('update', this.handleAwarenessUpdate)
    this.detach = transport.attach(name, {
      open: (link) => this.handleOpen(link),
      frame: (type, payload) => this.handleFrame(type, payload),
      close: () => this.handleClose(),
    })
  }

  /** Stops syncing. The doc and the connection are left alone; the awareness is destroyed only if this created it. */
  destroy = () => {
    if (this.destroyed) return
    this.destroyed = true
    // Tell the others we left rather than leaving a ghost until it times out. Must go out before we detach.
    if (this.awareness)
      this.yjs.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy')
    this.awareness?.off('update', this.handleAwarenessUpdate)
    // Without this the server keeps the connection in the room, and a later provider for the same name on this connection would never be asked for its edits.
    if (this.link) this.send(MSG_LEAVE, new Uint8Array(0))
    this.detach()
    if (this.ownsAwareness) this.awareness!.destroy()
    this.doc.off('updateV2', this.handleUpdate)
    this.doc.off('destroy', this.destroy)
    this.setSynced(false)
  }

  private setSynced(synced: boolean) {
    if (this.synced === synced) return
    this.synced = synced
    if (synced) this.resolveSynced(this)
    this.onSyncedChange?.(synced)
  }

  private send(type: number, payload: Uint8Array, unreliable = false) {
    this.transport.send(this.name, type, payload, { unreliable })
  }

  private handleOpen(link: Link) {
    this.link = link
    const sync = encoding.createEncoder()
    writeSyncStep1(sync, this.doc, this.yjs)
    this.send(MSG_SYNC, encoding.toUint8Array(sync))
    const state = this.awareness?.getLocalState()
    if (this.awareness && state != null) {
      // Re-set it to advance the clock: the server and the other clients saw us removed when the
      // last connection dropped, and they ignore a state whose clock is not newer than the one they have.
      this.announcing = true
      try {
        this.awareness.setLocalState(state)
      } finally {
        this.announcing = false
      }
    }
  }

  private handleClose() {
    this.link = null
    this.setSynced(false)
    if (this.awareness) {
      // Everyone else's presence came through the server; without it that data is stale.
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID)
      this.yjs.removeAwarenessStates(this.awareness, others, this)
      // Forget their clocks too, so the same states are accepted when the server resends them on reconnect.
      for (const id of others) this.awareness.meta.delete(id)
    }
  }

  private handleFrame(type: number, payload: Uint8Array) {
    try {
      if (type === MSG_SYNC) {
        const reply = encoding.createEncoder()
        const decoder = decoding.createDecoder(payload)
        const messageType = readSyncMessage(decoder, reply, this.doc, this, this.yjs)
        if (messageType === SYNC_STEP2) this.setSynced(true)
        if (encoding.length(reply) > 0) this.send(MSG_SYNC, encoding.toUint8Array(reply))
      } else if (type === MSG_AWARENESS && this.awareness) {
        this.yjs.applyAwarenessUpdate(this.awareness, payload, this)
      }
    } catch (error) {
      console.error('[y-transport]', error)
    }
  }

  private handleUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || !this.link) return
    const e = encoding.createEncoder()
    writeUpdate(e, update)
    this.send(MSG_SYNC, encoding.toUint8Array(e))
  }

  private handleAwarenessUpdate = (
    { added, updated, removed }: AwarenessChanges,
    origin: unknown,
  ) => {
    if (origin === this || !this.link || !this.awareness) return
    const changed = [...added, ...updated, ...removed]
    // Presence is perishable: it goes as a datagram where there is one, and is resent every 15s
    // anyway. A departure is not resent, so it goes reliably, as does the first state on a connection.
    const unreliable = !this.announcing && removed.length === 0
    this.send(MSG_AWARENESS, this.yjs.encodeAwarenessUpdate(this.awareness, changed), unreliable)
  }
}
