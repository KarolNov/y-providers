import type { UpdateCodec } from 'y-append-log/core'

/**
 * The document as the persistence uses it. Both `Y.Doc` from `yjs` (v13) and
 * from `@y/y` (v14) fit, so the core never imports either.
 */
export interface PersistenceDoc {
  on(event: 'updateV2', f: (update: Uint8Array, origin: any) => void): void
  on(event: 'destroy', f: () => void): void
  off(event: 'updateV2', f: (update: Uint8Array, origin: any) => void): void
  off(event: 'destroy', f: () => void): void
  transact(f: () => void, origin?: unknown): unknown
}

/** The Yjs functions the persistence needs, passed in by the entry for one Yjs major. */
export interface PersistenceYjs<D> extends UpdateCodec {
  applyUpdateV2(doc: D, update: Uint8Array, origin?: unknown): void
  encodeStateAsUpdateV2(doc: D): Uint8Array
}
