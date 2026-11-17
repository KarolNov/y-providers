/** Yjs v14 (`@y/y`). Same API as `y-opfs`, which is for Yjs v13. */
import * as Y from '@y/y'
import * as core from './core/persistence.js'
import type { PersistenceOptions } from './core/persistence.js'
import type { PersistenceYjs } from './core/yjs.js'
import type { Storage } from 'y-append-log/core'

export * from './shared.js'

const yjs: PersistenceYjs<Y.Doc> = {
  decodeUpdateV2: Y.decodeUpdateV2,
  mergeUpdatesV2: Y.mergeUpdatesV2,
  applyUpdateV2: Y.applyUpdateV2,
  encodeStateAsUpdateV2: (doc) => Y.encodeStateAsUpdateV2(doc),
}

/**
 * Persists a `Y.Doc` as an append-only log with crash-safe compaction, with
 * per-document locking, live sync between tabs and events.
 */
export class OpfsPersistence extends core.OpfsPersistence<Y.Doc> {
  constructor(name: string, doc: Y.Doc, storage: Storage, options: PersistenceOptions = {}) {
    super(name, doc, storage, { ...options, yjs })
  }
}
