# Changelog

## Unreleased

- **Breaking:** `SyncServer`'s `storage` option takes a `DocumentStore` from [`@y-modern/storage`](../storage/README.md) in place of `DocStorage`, which is gone. Rename `store(name, update)` to `append(name, update)`, and add `delete(name)`. `load` resolves `Uint8Array[] | null`, applied in one transaction; a single update, a generator or an async iterable is no longer accepted. Any store on the shared contract (`SqlStore`, `ObjectDocumentStore`, `DurableObjectStore`, `ByteFileStore`) plugs in without an adapter. See [#91](https://github.com/KarolNov/y-modern/issues/91).
- **Breaking:** `MemoryDocStorage` and the `StoredState` type are removed. Use `MemoryDocumentStore` from `@y-modern/storage`.
- Documented the eviction policy for a `SyncServer` without `storage`: documents are kept by default, and `evictAfter` frees idle ones, which then come back only from a client that still holds them. See [#21](https://github.com/KarolNov/y-modern/issues/21).
- The package depends on `@y-modern/storage`. `DocumentStore` is re-exported from `@y-modern/transport/server` as a type.
