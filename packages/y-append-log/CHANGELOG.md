# Changelog

Breaking changes to the contract are announced here and bump the package's semver. There is no contract-version field.

## Unreleased

- **Breaking:** `load` resolves the stored updates, `Uint8Array[] | null`, in place of one merged update. Apply them in one transaction, or merge them with `Y.mergeUpdatesV2` where one update is needed. A store with nothing stored still resolves `null`, and never an empty array. `ByteFileStore` returns its log's snapshot and records unmerged, and `MemoryDocumentStore` a one-element array. The conformance helper applies what `load` resolves in one transaction and fails a store that resolves anything but an array. See [#103](https://github.com/KarolNov/y-modern/issues/103).

- **Breaking:** every update in the contract is in the Yjs v2 encoding, for `append` and for what `load` returns. v1 updates are rejected, and data stored as v1 no longer loads.
- `ByteFileStore`: a `DocumentStore` over a byte-file `Storage`, with the CRC record format, generation slots and compaction that `@y-modern/persistence` used to hold. Its records hold v2 updates, so logs written by earlier persistence versions (v1) do not load.
- `ByteFileStore` takes no cross-process lock unless given `lock`; `webLocks` is the Web Locks implementation. It remembers at most `maxCachedDocuments` log positions.
- `ByteFileLog`, `Storage`, `MemoryStorage` and `LockFn` are exported; persistence consumes them from here.
- `Storage` has an optional `appendIfSize(name, data, size)`: append only if the file is exactly `size` bytes, in one operation. `ByteFileLog.appendIfFresh` and `ByteFileStore.append` use it to check for other writers and append in one call; a `Storage` without it keeps working with `size()` then `append()`. `MemoryStorage` implements it. See [#14](https://github.com/KarolNov/y-modern/issues/14).
- `MemoryDocumentStore` and `ByteFileStore` decode the whole update on `append` and reject one that is truncated or not v2. Before, an update cut short by one byte was stored and broke every later `load`.

## 0.1.0

- `DocumentStore`: the per-document storage contract (`load`, `append`, `delete`, optional `close`).
- `MemoryDocumentStore`: an in-memory implementation.
- `conformanceCases` and `runConformance`: a runner-agnostic conformance helper for backends.
