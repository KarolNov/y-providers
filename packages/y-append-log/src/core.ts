/**
 * The version-free core: every class and helper takes the Yjs functions it
 * needs (`yjs`) instead of importing Yjs. For other providers that bring their
 * own Yjs adapter; apps use `y-append-log` (v13) or `y-append-log/y14` (v14).
 */
export type { AppendLogYjs, ConformanceDocs, UpdateCodec } from './core/yjs.js'
export type { DocumentStore } from './core/types.js'
export { MemoryDocumentStore } from './core/memory.js'
export { MemoryStorage, type Storage } from './core/byte-file-storage.js'
export {
  ByteFileLog,
  ByteFileStore,
  byteFileLockName,
  webLocks,
  type ByteFileLogOptions,
  type ByteFileStoreOptions,
  type LockFn,
  type LogPosition,
  type WithYjs,
} from './core/byte-file.js'
export {
  conformanceCases,
  runConformance,
  type ConformanceBackend,
  type ConformanceCase,
  type ConformanceFactory,
} from './core/conformance.js'
