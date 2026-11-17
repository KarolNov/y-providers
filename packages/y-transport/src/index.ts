/** Yjs v13 (`yjs`, `y-protocols`). For Yjs v14 import `y-transport/y14`, which has the same API. */
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import * as core from './core/provider.js'
import type { SyncProviderOptions } from './core/provider.js'
import type { Transport } from './core/transport.js'
import { yjs } from './adapter13.js'

export * from './shared.js'

/** Syncs a `Y.Doc` with a sync server over a shared `Transport`, with presence. */
export class SyncProvider extends core.SyncProvider<Y.Doc, Awareness> {
  constructor(
    name: string,
    doc: Y.Doc,
    transport: Transport,
    options: SyncProviderOptions<Awareness> = {},
  ) {
    super(name, doc, transport, { ...options, yjs })
  }
}
