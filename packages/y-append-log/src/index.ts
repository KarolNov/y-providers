/** Yjs v13 (`yjs`). For Yjs v14 import `y-append-log/y14`, which has the same API. */
import * as core from './core.js'
import type {
  ByteFileLogOptions,
  ByteFileStoreOptions,
  ConformanceCase,
  ConformanceFactory,
  Storage,
} from './core.js'
import { yjs } from './adapter13.js'

export type {
  ByteFileLogOptions,
  ByteFileStoreOptions,
  ConformanceBackend,
  ConformanceCase,
  ConformanceFactory,
  DocumentStore,
  LockFn,
  LogPosition,
  Storage,
} from './core.js'
export { MemoryStorage, byteFileLockName, webLocks } from './core.js'

/** One document's CRC log on a byte-file `Storage`, with crash-safe compaction. */
export class ByteFileLog extends core.ByteFileLog {
  constructor(storage: Storage, name: string, options: ByteFileLogOptions = {}) {
    super(storage, name, { ...options, yjs })
  }
}

/** The shared `DocumentStore` over a byte-file `Storage`, compacting by itself. */
export class ByteFileStore extends core.ByteFileStore {
  constructor(storage: Storage, options: ByteFileStoreOptions = {}) {
    super(storage, { ...options, yjs })
  }
}

/** Keeps documents in memory, merged. */
export class MemoryDocumentStore extends core.MemoryDocumentStore {
  constructor(docs?: Map<string, Uint8Array>) {
    super(yjs, docs)
  }
}

/** The cases a `DocumentStore` backend must pass, as data for any test runner. */
export function conformanceCases(factory: ConformanceFactory): ConformanceCase[] {
  return core.conformanceCases(factory, yjs)
}

/** Runs every conformance case in order and throws on the first failure. */
export function runConformance(factory: ConformanceFactory): Promise<void> {
  return core.runConformance(factory, yjs)
}
