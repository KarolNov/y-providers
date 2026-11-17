import type { DocumentStore } from './types.js'
import { assertUpdate } from './update.js'
import type { UpdateCodec } from './yjs.js'

/**
 * Keeps documents in memory, merged. For tests and for servers that do not
 * need to survive a restart. Stores built over the same `docs` map share
 * their documents.
 */
export class MemoryDocumentStore implements DocumentStore {
  constructor(
    private readonly yjs: UpdateCodec,
    readonly docs = new Map<string, Uint8Array>(),
  ) {}

  async load(name: string) {
    const merged = this.docs.get(name)
    return merged ? [merged.slice()] : null
  }

  async append(name: string, update: Uint8Array) {
    const prev = this.docs.get(name)
    assertUpdate(this.yjs, update)
    this.docs.set(name, prev ? this.yjs.mergeUpdatesV2([prev, update]) : update.slice())
  }

  async delete(name: string) {
    this.docs.delete(name)
  }
}
