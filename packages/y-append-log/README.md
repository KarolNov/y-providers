# y-append-log

Part of [y-providers](../../README.md). The per-document storage contract for Yjs updates, an append-only byte-file log with crash-safe compaction, an in-memory store, and a conformance helper for backend authors. [`y-opfs`](../y-opfs) and [`y-transport`](../y-transport) build on it.

## Yjs v13 and v14

The main entry is for Yjs v13 (`yjs`). For Yjs v14 (`@y/y`, currently a release candidate) import the `/y14` entry instead; the API is the same.

```ts
import { ... } from 'y-append-log' // yjs ^13.6
import { ... } from 'y-append-log/y14' // @y/y >=14.0.0-rc.30
```

Each entry loads only its own Yjs, so an app never bundles both. Install the one you use: Yjs is an optional peer dependency. The `/y14` entry needs Node 22 or later, like `@y/y`.

`y-append-log/core` exports the same classes without any Yjs: they take the Yjs functions as a `yjs` option. It is for other providers that bring their own adapter; apps use `y-append-log` or `y-append-log/y14`.

## The contract

```ts
interface DocumentStore {
  load(name: string): Promise<Uint8Array[] | null>
  append(name: string, update: Uint8Array): Promise<void>
  delete(name: string): Promise<void>
  close?(): Promise<void> | void
}
```

- Every update is in the Yjs v2 encoding (`Y.encodeStateAsUpdateV2`, the doc's `updateV2` event, `Y.applyUpdateV2`), going in and coming out.
- `load` resolves the updates stored for `name`, or `null` when nothing is stored. `null` tells a new document from an empty one, and the array is never empty. Apply the updates in one transaction, which is faster than merging them first. A caller that needs one update merges them with `Y.mergeUpdatesV2`:

  ```ts
  const updates = await store.load(name)
  if (updates) {
    doc.transact(() => {
      for (const update of updates) Y.applyUpdateV2(doc, update)
    })
  }
  ```

- `append` adds one update.
- `delete` removes the document and nothing else. Every backend has it.
- `close` is optional: stores with nothing to release leave it out.

Compaction is not a method. A backend compacts in whatever way its store allows.

## Guarantees

1. **Concurrent writers are safe.** Any number of writers (tabs, client and server, several servers) may `append` to one document at once. Each backend makes that safe itself; callers never coordinate.
2. **A resolved `append` is durable and visible.** It is durable to the backend's own guarantee, and every `load` that starts after it resolves, by any writer, includes it. There is no ordering promise. A backend that buffers flushes before it resolves.

## Memory store

```ts
import { MemoryDocumentStore } from 'y-append-log'

const store = new MemoryDocumentStore()
await store.append('room', update)
const updates = await store.load('room') // [the merged update]
```

It keeps each document merged, so `load` resolves a one-element array. Stores built over the same `Map` share their documents: `new MemoryDocumentStore(map)`.

## Byte-file adapter

`ByteFileStore` implements `DocumentStore` over a byte-file `Storage` (`read`, `size`, `append`, `write`, `remove`, optional `appendIfSize` and `close`), the shape of OPFS, Node fs, IndexedDB and memory. `appendIfSize` appends only when the file is still the length the writer left it, in one operation; without it each append costs a separate `size()` first. This package ships `MemoryStorage`; [`y-opfs`](../y-opfs) ships the OPFS, IndexedDB and Node fs ones.

```ts
import { ByteFileStore, MemoryStorage } from 'y-append-log'

const store = new ByteFileStore(new MemoryStorage())
```

`load` resolves the newest slot's snapshot followed by the updates appended after it, unmerged. Each document is two slot files (`<name>.0.ylog`, `<name>.1.ylog`) holding checksummed records. Every file starts with a snapshot record carrying a generation number, followed by appended updates. The store compacts by itself once a log passes `maxRecords` (default 500) or `maxBytes` (default 1 MiB): it writes the merged state to the other slot at generation + 1, then deletes the old one. On load the valid slot with the highest generation wins and a torn tail is dropped.

Writers in one process are serialised per document. Writers in several tabs or processes on the same `Storage` need a lock, or an append can be lost while another writer compacts. The store takes none by default; pass `lock`, a function that runs `fn` while holding a lock named `name`:

```ts
import { ByteFileStore, webLocks } from 'y-append-log'

// tabs of one browser: Web Locks
new ByteFileStore(storage, { lock: webLocks })

// processes or machines sharing one directory: any distributed lock, e.g. Redlock
import Redlock from 'redlock'
const redlock = new Redlock([redis])
new ByteFileStore(storage, {
  lock: async (name, fn) => {
    const lock = await redlock.acquire([name], 5_000)
    try {
      return await fn()
    } finally {
      await lock.release()
    }
  },
})
```

The store remembers the log position of up to `maxCachedDocuments` documents (default 100, least recently used first); a forgotten one costs one re-read. The store owns its `Storage`: `close()` closes it.

`ByteFileLog` is the per-document engine below the store, for callers that keep their own lock, position and live document. `OpfsPersistence` is one; other backends should use the store.

## A minimal backend

A backend that appends rows and loads them as they are:

```ts
import type { DocumentStore } from 'y-append-log'

class RowStore implements DocumentStore {
  constructor(readonly rows = new Map<string, Uint8Array[]>()) {}

  async load(name: string) {
    const rows = this.rows.get(name)
    return rows?.length ? rows.slice() : null
  }
  async append(name: string, update: Uint8Array) {
    const rows = this.rows.get(name) ?? []
    rows.push(update)
    this.rows.set(name, rows)
  }
  async delete(name: string) {
    this.rows.delete(name)
  }
}
```

## Testing a backend

`conformanceCases` takes a backend factory and returns named cases, so any runner can register them. The factory returns a fresh, empty backend; `open()` returns a new handle onto the same data, so the cases can check concurrent and independent writers. `dispose` is optional.

```ts
import { test } from 'vitest'
import { conformanceCases } from 'y-append-log'

const factory = () => {
  const rows = new Map()
  return { open: () => new RowStore(rows) }
}

for (const c of conformanceCases(factory)) test(c.name, c.run)
```

The cases are sequential and include a few hundred appends, so a slow backend (a remote store, an fsynced file) needs a longer per-case timeout than most runners default to (vitest: `test(c.name, c.run, 60_000)`).

Without a runner, `await runConformance(factory)` runs every case and throws on the first failure.

The contract does not require `append` to validate its input. `MemoryDocumentStore` and `ByteFileStore` do: they reject bytes that are not a whole Yjs v2 update, including a truncated one and a v1 update.

The cases check concurrent appends, read-your-writes across independent handles, `load` resolving an array of updates that, applied in one transaction, give the merged document, `null` for an unknown document, isolation between document names, `delete`, and a few hundred appends still loading in full. They assert behaviour only: no thresholds, row layout or key formats.

## Versioning

Package semver plus [CHANGELOG.md](CHANGELOG.md). Nothing else.
