/**
 * Per-document storage of Yjs updates. Every update going in and coming out is
 * in the v2 encoding (`Y.encodeStateAsUpdateV2`, `Y.applyUpdateV2`).
 *
 * Two guarantees hold for every backend:
 *
 * 1. Any number of writers (tabs, client and server, several servers) may
 *    `append` to one document at the same time. Each backend makes that safe
 *    itself; callers never coordinate.
 * 2. A resolved `append` is durable to the backend's own guarantee, and every
 *    `load` that starts after it resolves, by any writer, includes it. Nothing
 *    is promised about ordering. A backend that buffers flushes before resolving.
 *
 * Compaction is the backend's own business and not part of the contract.
 */
export interface DocumentStore {
  /**
   * The v2 updates stored for `name`, or null when nothing is stored. Never an
   * empty array. Applied together, in one transaction, they give the document;
   * a caller that wants one update merges them (`Y.mergeUpdatesV2`).
   */
  load(name: string): Promise<Uint8Array[] | null>
  /** Add one Yjs v2 update to the document. */
  append(name: string, update: Uint8Array): Promise<void>
  /** Remove everything stored for `name`. Other documents are untouched. */
  delete(name: string): Promise<void>
  /** Release what the store holds. Optional: stores with nothing to release omit it. */
  close?(): Promise<void> | void
}
