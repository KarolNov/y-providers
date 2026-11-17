/** Yjs v14 (`@y/y`, `@y/protocols`). Same API as `y-transport`, which is for Yjs v13. */
import type * as Y from '@y/y'
import type { Awareness } from '@y/protocols/awareness'
import * as core from './core/provider.js'
import type { SyncProviderOptions } from './core/provider.js'
import type { Transport } from './core/transport.js'
import { yjs } from './adapter14.js'

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
