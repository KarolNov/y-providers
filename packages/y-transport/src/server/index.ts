/** Yjs v13 server. For Yjs v14 import `y-transport/server/y14`, which has the same API. */
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import * as core from '../core/server/index.js'
import type { SyncServerOptions } from '../core/server/index.js'
import { yjs } from '../adapter13.js'

export type { DocumentStore, Link, SyncServerOptions } from '../core/server/index.js'

/**
 * Documents ("rooms") and the links connected to them. Hand it a `Link` per
 * connection, from `y-transport/server/ws` or `/server/webtransport` or your own.
 */
export class SyncServer extends core.SyncServer<Y.Doc, Awareness> {
  constructor(options: SyncServerOptions = {}) {
    super({ ...options, yjs })
  }
}
