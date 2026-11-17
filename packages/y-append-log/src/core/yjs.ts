/**
 * The Yjs functions the log needs, passed in by the entry for one Yjs major
 * (`y-append-log` for v13, `y-append-log/y14` for v14), so nothing under
 * `core/` imports Yjs itself.
 */
export interface UpdateCodec {
  /** Decodes a whole v2 update, throwing when it is not one. */
  decodeUpdateV2(update: Uint8Array): unknown
  mergeUpdatesV2(updates: Uint8Array[]): Uint8Array
}

/**
 * Document operations the conformance cases use. They write and read entries
 * of one shared map, which v13 and v14 spell differently.
 */
export interface ConformanceDocs {
  /** One v2 update that sets `key` to `value` in map `m`, written by client `clientID`. */
  entryUpdate(clientID: number, key: string, value: string): Uint8Array
  /** Applies `updates` to a new document in one transaction and returns map `m`'s entries. */
  entries(updates: Uint8Array[]): Record<string, unknown>
}

/** Everything a `y-append-log` entry passes to the core. */
export interface AppendLogYjs extends UpdateCodec, ConformanceDocs {}
