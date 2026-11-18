# y-opfs

Part of [y-providers](https://github.com/KarolNov/y-providers). [Yjs](https://yjs.dev) persistence (v0.1): append-only update log on the Origin Private File System, written from a Worker via sync access handles. Crash-safe compaction, IndexedDB fallback, Node/Bun filesystem adapter.

> **Status: experimental.** The OPFS backend is built to explore newer browser storage APIs (sync access handles, Web Locks) and a crash-safe log format. It is not a drop-in replacement for [`y-indexeddb`](https://github.com/yjs/y-indexeddb), and for many apps `y-indexeddb`, or this package's IndexedDB mode, is probably the better choice. See [Which backend should I use?](#which-backend-should-i-use).

## Install

```sh
npm install y-opfs yjs              # Yjs v13
npm install y-opfs @y/y             # Yjs v14 (release candidate)
```

`y-append-log` comes with it as a dependency.

## Yjs v13 and v14

The main entry is for Yjs v13 (`yjs`). For Yjs v14 (`@y/y`, currently a release candidate) import the `/y14` entry instead; the API is the same.

```ts
import { ... } from 'y-opfs' // yjs ^13.6
import { ... } from 'y-opfs/y14' // @y/y >=14.0.0-rc.30
```

Each entry loads only its own Yjs, so an app never bundles both. Install the one you use: Yjs is an optional peer dependency. The `/y14` entry needs Node 22 or later, like `@y/y`. The `./node` and `./worker` entries hold no Yjs and serve both majors.

## Persistence

```ts
import * as Y from 'yjs'
import { OpfsPersistence, openStorage } from 'y-opfs'

const { storage, active } = await openStorage({
  createWorker: () => new Worker(new URL('y-opfs/worker', import.meta.url), { type: 'module' }),
})
const doc = new Y.Doc()
const persistence = new OpfsPersistence('my-doc', doc, storage)
await persistence.whenSynced
```

`openStorage` tries the backends in `order` (default `['opfs', 'indexeddb']`). It really opens each one and asks it for the size of a file that does not exist, and the first that answers serves the whole session: there is no failover after open. `active` names it. It rejects if every candidate fails.

```ts
await openStorage({ order: ['indexeddb'] }) // IndexedDB only, no worker; rejects if it fails
await openStorage({ order: ['opfs'], createWorker }) // OPFS only, rejects if it fails
await openStorage({ order: ['opfs', 'indexeddb', 'memory'], createWorker }) // memory as a last resort
```

`'memory'` keeps nothing across reloads and is only used when listed. Check `active === 'memory'` to warn the user.

Node: `new NodeFsStorage('./data')` from `y-opfs/node`.

### How it stays crash-safe

Each document uses two slot files. Every file starts with a snapshot record carrying a generation number; updates are checksummed records appended after it. Compaction writes full state to the other slot at generation + 1, then deletes the old one. On load the valid slot with the highest generation wins and a torn tail is truncated. No atomic rename required.

### Which backend should I use?

Use `y-indexeddb` if you want the mature, widely deployed option. The benchmarks below show it as faster or equal in most cases, and IndexedDB has years of cross-browser testing behind it.

Reasons to still consider this package:

- **Concurrent writers.** IndexedDB transactions give cross-tab atomicity natively. The OPFS path has to build the same guarantee from Web Locks, exclusive sync access handles with retries, and a size check, so it is the harder design to get right (the multi-writer tests exist for that reason). The IndexedDB mode here keeps the same locking and log format, so it is the conservative way to use this package.
- **Crash-safe log.** Checksummed records, torn-tail truncation and generation-numbered slot files, for both backends.
- **Newer APIs.** OPFS with sync access handles is where browser file storage is heading, but support and behaviour still vary (Safari in particular), and it needs a Worker. The browser tests run in Playwright's Chromium, Firefox and WebKit builds and pass in all three; Safari itself is not tested.
- **Durability.** In the measurements below, both backends kept every acknowledged write when storage ran out and when the browser was killed, and eviction removed both together. Neither survives better. See [Durability and storage limits](#durability-and-storage-limits).

### Durability and storage limits

What happens to stored documents when storage runs out, when the browser evicts a site's data, and when the browser is killed. Measured 2026-10-04 with Playwright 1.63 on macOS (Apple M1): Chromium 153, Firefox 155 and WebKit 26.6. The WebKit build is Playwright's, not Safari. Measured in [y-modern](https://github.com/KarolNov/y-providers#where-this-came-from), my private Yjs playground, whose durability harness isn't part of y-providers; the code measured is the code in this package, with Yjs v13.

**In an app:**

1. **Ask for persistent storage** with `navigator.storage.persist()`, for example once the user has saved something. Best-effort data is deleted, a whole site at a time, when the browser needs space; persisted data is not. Chromium and Safari decide without asking the user (Chromium on engagement, installation or a bookmark; Safari for example for a Home Screen web app). Firefox shows a prompt. In the headless test browsers Chromium and WebKit refused, and Firefox waited on its prompt.
2. **Handle `QuotaExceededError`.** When storage is full, `flush()` rejects and background writes report to `onError`, with `error.name === 'QuotaExceededError'` for both backends in Chromium and Firefox (WebKit's quota is not measured). A failed update stays in the `Y.Doc` and in the write queue and is retried with the next write, but until then it is not stored. Nothing already stored is lost.
3. **Leave headroom for compaction.** Compaction writes a full copy of the document into the other slot before deleting the old one, so it needs free space about the size of the document. If that copy does not fit, the update that triggered the compaction is already stored: the error goes to `onError`, writes keep appending to the old log, and compaction is tried again once the log has grown by another quarter of `maxBytes`. A log that cannot be compacted keeps every update, but loads more slowly.
4. **A full IndexedDB in Firefox cannot be cleared.** Once the site is at its limit, Firefox refuses every IndexedDB write, deletes included, so `clearData()` rejects with `QuotaExceededError`, even after a restart. The document still loads with everything stored. In a separate probe, deleting the whole database with `indexedDB.deleteDatabase('y-opfs')` (or your `IdbStorage` database name) freed the space; it waits until every connection to the database is closed, and an open `IdbStorage` holds a connection, so call `storage.close()` first (it also closes itself when another tab deletes or upgrades the database). `close()` makes later calls on that instance reject. OPFS in Firefox and both backends in Chromium could be cleared while full.
5. **Keep a copy elsewhere** of anything that must not be lost. The browser can delete all of it: eviction, the user clearing site data, or Safari's 7-day rule. An evicted document loads as an empty one, without an error, so the app cannot tell it apart from a new document.

**Storage running out.** Each document is written in 64 KiB entries, waiting for each one to be stored, until a write fails. Another 32 writes are then attempted, the browser is restarted and the document reloaded.

| Browser, backend         | Limit                      | Stored when full | After reload | Error                | Cleared while full |
| ------------------------ | -------------------------- | ---------------: | -----------: | -------------------- | ------------------ |
| Chromium, OPFS           | 20 MiB (DevTools override) |   255 (15.9 MiB) |          255 | `QuotaExceededError` | yes                |
| Chromium, IDB            | 20 MiB (DevTools override) |   307 (19.2 MiB) |          307 | `QuotaExceededError` | yes                |
| Firefox, OPFS            | 10 MiB (site limit, pref)  |    152 (9.5 MiB) |          152 | `QuotaExceededError` | yes                |
| Firefox, IDB             | 10 MiB (site limit, pref)  |    157 (9.8 MiB) |          158 | `QuotaExceededError` | no                 |
| Firefox, OPFS, persisted | 15 MiB (global limit)      |   232 (14.5 MiB) |          232 | `QuotaExceededError` | yes                |
| Firefox, IDB, persisted  | 15 MiB (global limit)      |   237 (14.8 MiB) |          237 | `QuotaExceededError` | no                 |

WebKit is not measured: its quota cannot be lowered for a test and is a share of the disk. Headless Chromium never grants `persist()`, so the persisted rows are Firefox only; there a persisted site may use the whole global limit.

No acknowledged entry was lost, and the 32 further writes all failed, so each limit is a hard one. In Firefox's IndexedDB one entry more than acknowledged came back: the update whose write had failed, stored on a later retry. Where the document could be cleared, writes worked again afterwards.

Before this was measured, Firefox's OPFS lost whole documents silently. Over quota, its `FileSystemSyncAccessHandle.write()` stores what fits and returns a shorter count instead of throwing. `OpfsStorage` ignored the count, so writes were acknowledged that never landed, compaction wrote truncated snapshots, and on reload no slot was valid: 309 entries acknowledged, 0 after reload. It now checks the count, rolls the write back and throws `QuotaExceededError`.

**Eviction.** Measured in Firefox only, the one engine whose limit can be lowered for a test (global limit 15 MiB); not in Chromium or WebKit. Site A stores a document with each backend and closes its tab; site B then fills its own storage past the global limit.

| Site A                | OPFS document after | IndexedDB document after |
| --------------------- | ------------------: | -----------------------: |
| best-effort (default) |     0 of 40 entries |          0 of 40 entries |
| `persist()` granted   |    40 of 40 entries |         40 of 40 entries |

Eviction removed the whole site, both backends at once, and reopening raised no error: the documents loaded empty.

**Killed browser.** Every process started with the test profile is killed with `SIGKILL` while a tab writes 16 KiB entries, then the profile is reopened; 5 rounds per browser and backend. No acknowledged write was lost in any round, and the log was never unreadable. Up to 4 entries more than the acknowledged count were present: written, but killed before the acknowledgement arrived. This is process death only. The operating system's cache survives it, so it says nothing about power loss or an OS crash. `OpfsStorage` flushes every write; Chromium commits IndexedDB with relaxed durability by default, which a power loss can roll back.

**Private browsing.** In WebKit's non-persistent data store (Playwright's default context, the kind Safari uses for private windows), `navigator.storage.getDirectory()` fails with `UnknownError` while `opfsSupported()` still returns true. `openStorage()` handles this: the OPFS probe fails on open, so it moves on to IndexedDB, which works there. `order: ['opfs']` still fails loudly. A test runs this in WebKit's non-persistent store; not checked in Safari itself. Outside it, with a profile on disk, WebKit's OPFS passes the same tests as Chromium's and Firefox's.

**Browser policies** (published, not measured here; from [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) and [WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/)):

| Browser    | Per-site quota                                                                            | `persist()`                      | Eviction                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium   | up to 60% of the disk; all sites together 80%                                             | granted or refused automatically | whole sites, least recently used first, when the total is exceeded or the disk runs low; persisted sites skipped                                                       |
| Firefox    | best-effort: 10% of the disk or 10 GiB, whichever is smaller; persisted: 50%, up to 8 TiB | prompt                           | whole sites, least recently used first; persisted sites skipped                                                                                                        |
| Safari 17+ | about 60% of the disk in Safari, 15% in other apps' web views; all sites 80% / 20%        | granted by heuristics, no prompt | whole sites, least recently used first; persisted sites skipped. Also deletes script-written storage of sites without user interaction in the last 7 days of use (MDN) |

### Known limitations (v0.1)

- Live cross-tab sync uses `BroadcastChannel`. A tab that was frozen or suspended can miss messages; it catches up on its next write, when another message arrives, or when you call `persistence.refresh()` (see [Multiple tabs](#multiple-tabs)). No awareness or presence; that comes with the network provider.
- Sequential durable writes, each awaited before the next, are about 3x slower than `y-indexeddb` on OPFS and 1.6x on the IndexedDB fallback (see Benchmarks). Updates applied back to back are faster than `y-indexeddb`.

### Multiple tabs

All writes for a document run under a Web Lock. Under the lock a writer checks that the active file is the size it left it; if not, another tab wrote or compacted, so it re-reads and merges before appending. Covered by browser tests with 4 contending writers.

**Live sync.** Tabs that open the same document name converge without a reload. After each append (inside the lock) the writer posts the update on a `BroadcastChannel` named after the storage and the document. Receivers apply it to their `Y.Doc` with the persistence as origin, so it is not written or broadcast again.

Each message also says where the log was before and after (slot, generation, byte length). A receiver that is exactly at the "before" position adopts the "after" position, so its next write needs no re-read; this includes compactions, which are announced the same way. If the position does not match, the tab missed or reordered something, and it re-reads from storage. Storage stays the source of truth: a lost message only delays convergence, and Yjs applies updates in any order, twice, or not at all without harm.

- Updates over 256 KiB are not cloned to every tab. A small "changed" signal is sent instead and receivers re-read. Measured in Chromium, cloning 1 MB to 4 listeners took about 1.2 ms and 10 MB about 14 ms, against 4 to 7 ms to read a 10 MB file back; a typical update is a few hundred bytes.
- `persistence.refresh()` pulls in whatever other tabs persisted, for example from a `visibilitychange` handler in an app that expects long suspensions.
- Channels are scoped by the storage (IndexedDB database name, Node directory, OPFS directory), so same-named documents in different stores do not exchange data. If you run a custom OPFS worker with another directory, pass it to `new WorkerStorage(worker, directory)`.

```ts
new OpfsPersistence('my-doc', doc, storage) // broadcast: true, uses the global BroadcastChannel if present
new OpfsPersistence('my-doc', doc, storage, { broadcast: false }) // off; tabs merge on their next write
new OpfsPersistence('my-doc', doc, storage, { broadcast: (name) => new BroadcastChannel(name) }) // your own channel
```

**Clearing data.** `persistence.clearData()` deletes the stored files and detaches. Other tabs on the same channel are told: they detach too and emit `cleared` with `remote: true`. Their doc still holds content that is no longer in storage, so discard it and open a fresh one. A tab that does not get the message (broadcast off, or frozen) keeps the old behaviour and writes its own state back on its next write, and writes that are in flight in another tab when you clear can survive.

**Watching what it does.** `onEvent` reports what the persistence is doing, each event with the log position afterwards (`{ slot, generation, records, bytes }`). It is for debugging and status displays.

```ts
new OpfsPersistence('my-doc', doc, storage, { onEvent: (e) => console.log(e.type, e.position) })
// load | flush {updates, bytes} | compact | resync {reason} | broadcast-sent {kind} | broadcast-received {kind, adopted} | cleared {remote}
```

`resync.reason` says why the log was re-read (`write`: another tab had written since we last looked; `message`: a broadcast did not continue from our position; `refresh`; `compact`). `broadcast-received.adopted` is true when the message continued exactly from our position, so nothing had to be re-read.

In Node the global `BroadcastChannel` connects workers and the main thread of one process only (it is `unref`'d, so it does not keep the process alive); separate processes sharing a `NodeFsStorage` directory still merge on their next write.

## Benchmarks

Earlier measurements, made in [y-modern](https://github.com/KarolNov/y-providers#where-this-came-from), my private Yjs playground, where the benchmark harness lives (it isn't part of y-providers). The code measured is the code in this package; only package names and the Yjs adapter changed since. They were taken with Yjs v13.

Compared against [`y-indexeddb`](https://github.com/yjs/y-indexeddb) in headless Chromium: `y-indexeddb`, `OpfsPersistence` over OPFS (via the worker), and `OpfsPersistence` over its IndexedDB fallback. Every backend receives the same deterministic updates, each timed run uses a fresh database, and timing stops only after the data is committed. Defaults are used everywhere; nothing is tuned.

Measured 2026-10-17 on Apple M1, 8 logical cores, 8 GB RAM (Darwin 24.6.0 arm64), Chromium 153.0.8010.12 (headless, Playwright 1.63.0). y-indexeddb 9.0.12, yjs 13.6.33. Median of the samples per cell, lower is better, best per row in bold. Mode: full.

#### Write

Time until everything is stored; updates per second in brackets.

| Case                                                    |          y-indexeddb |         OPFS (worker) |    IndexedDB fallback |
| ------------------------------------------------------- | -------------------: | --------------------: | --------------------: |
| 5000 small updates, applied back to back (text)         |     760 ms (6,581/s) |     301 ms (16,589/s) | **299 ms (16,711/s)** |
| 1000 small updates, each awaited until stored (text)    | **179 ms (5,596/s)** |      538 ms (1,859/s) |      290 ms (3,447/s) |
| 5000 small updates, applied back to back (records)      |     792 ms (6,317/s) | **307 ms (16,303/s)** |     338 ms (14,815/s) |
| 1000 small updates, each awaited until stored (records) | **188 ms (5,325/s)** |      536 ms (1,867/s) |      293 ms (3,408/s) |
| one update of 1.1 MB                                    |              41.7 ms |               37.2 ms |           **35.6 ms** |
| one update of 8.9 MB                                    |           **361 ms** |                438 ms |                415 ms |

#### Load

Time from opening to a fully populated doc. The "worker already started" rows exclude spawning the OPFS worker.

| Case                                                                                    | y-indexeddb | OPFS (worker) | IndexedDB fallback |
| --------------------------------------------------------------------------------------- | ----------: | ------------: | -----------------: |
| ~10 KB state (250 edits, 18 KB state)                                                   |     2.20 ms |       5.10 ms |        **1.20 ms** |
| ~10 KB state (250 edits, 18 KB state), worker already started                           |     2.20 ms |       1.40 ms |        **1.20 ms** |
| ~100 KB state (1500 edits, 104 KB state)                                                | **3.80 ms** |       7.70 ms |            4.50 ms |
| ~100 KB state (1500 edits, 104 KB state), worker already started                        |     3.70 ms |   **3.60 ms** |        **3.60 ms** |
| ~1 MB state (14000 edits, 1010 KB state)                                                |     40.4 ms |       35.0 ms |        **34.3 ms** |
| ~1 MB state (14000 edits, 1010 KB state), worker already started                        |     44.7 ms |   **30.9 ms** |            37.1 ms |
| ~4 MB state (57500 edits, 4007 KB state)                                                |      204 ms |        191 ms |         **179 ms** |
| ~4 MB state (57500 edits, 4007 KB state), worker already started                        |      183 ms |    **143 ms** |             154 ms |
| text document, 20k edits of history (20000 edits, 129 KB state)                         | **7.70 ms** |       16.0 ms |            11.5 ms |
| text document, 20k edits of history (20000 edits, 129 KB state), worker already started | **6.90 ms** |       9.00 ms |            9.60 ms |

#### Stored size

Payload bytes held for the document after the same edits, once background trimming has finished; in brackets the growth of `navigator.storage.estimate().usage`, a single coarse origin-wide reading that includes engine overhead and IndexedDB compression.

| Case                                                            |              y-indexeddb |                OPFS (worker) |           IndexedDB fallback |
| --------------------------------------------------------------- | -----------------------: | ---------------------------: | ---------------------------: |
| ~10 KB state (250 edits, 18 KB state)                           |  21.5 kB (est. 118.8 kB) |   **10.8 kB (est. 11.0 kB)** |   **10.8 kB (est. 81.9 kB)** |
| ~100 KB state (1500 edits, 104 KB state)                        | 104.4 kB (est. 127.0 kB) |   **63.1 kB (est. 63.3 kB)** |  **63.1 kB (est. 135.2 kB)** |
| ~1 MB state (14000 edits, 1010 KB state)                        |  1.01 MB (est. 585.7 kB) | **595.8 kB (est. 596.0 kB)** | **595.8 kB (est. 655.4 kB)** |
| ~4 MB state (57500 edits, 4007 KB state)                        |   4.01 MB (est. 2.20 MB) |   **2.31 MB (est. 2.31 MB)** |   **2.31 MB (est. 1.31 MB)** |
| text document, 20k edits of history (20000 edits, 129 KB state) | 129.4 kB (est. 155.6 kB) |   **80.7 kB (est. 80.9 kB)** |  **80.7 kB (est. 196.6 kB)** |

#### Compaction

Time to fold the stored updates into one snapshot.

| Case                                      | y-indexeddb | OPFS (worker) | IndexedDB fallback |
| ----------------------------------------- | ----------: | ------------: | -----------------: |
| 400 stored updates, ~27 KB state          |     3.30 ms |       1.60 ms |        **1.20 ms** |
| 400 stored updates on top of a ~1 MB base |     57.3 ms |       17.2 ms |        **16.3 ms** |

**Reading the results**

- `y-indexeddb` still wins the cases where every update must be stored before the next one: about 3x faster than OPFS and about 1.6x faster than our IndexedDB fallback. Earlier, each write made two storage calls, a size check to see whether another tab had written and then the append. Both now happen in one call (`Storage.appendIfSize`), which took these rows from about 870 ms to 540 ms on OPFS and from about 400 ms to 290 ms on the fallback, measured on the same machine. What remains on OPFS is mostly the cost of opening and closing a file handle and an access handle on every write, which other tabs need us to release. Keeping file handles between writes was tried and dropped: in Chromium a kept handle to a file another tab has removed still opens and reports a nonsense size. `flush()` costs almost nothing in this headless run, so durability is not what the gap is made of. Our writes also take a Web Lock, which `y-indexeddb` does not.
- `OpfsPersistence` wins updates applied back to back (about 2.5x faster), because it coalesces everything queued into one record. It also compacts faster.
- For single large updates the result is mixed: we are faster at 1.1 MB and `y-indexeddb` at 8.9 MB. Loads are mixed too: we are faster at 1 MB and 4 MB, `y-indexeddb` is faster for the document with 20k edits of history, and OPFS loses on small documents when the worker has to start first (5.1 ms against 2.2 ms at 10 KB).
- We store less in every size case: our records hold Yjs v2 updates, which are more compact than the v1 updates `y-indexeddb` stores. IndexedDB compresses on disk and OPFS files are not compressed, so the bracketed estimates differ from the payload. Treat the estimates as indicative, as they come from one coarse reading.
- `y-indexeddb` defers its trim until one second after the last write, so its write timings never include a compaction; ours compacts inline. Size and load rows wait for `y-indexeddb`'s trim to finish first.

**Method and limits**

- Medians over 5 to 11 timed runs after 1 to 2 warmups; backend order rotates every round.
- Edits are applied in 100-edit batches when building load and size documents, so our log holds batches while `y-indexeddb` stores each edit. "Awaited until stored" uses a barrier transaction for `y-indexeddb`, which has no flush API.
- One machine, one browser, headless, warm OS file cache. Loads reopen the same database in the same page, so they do not show a cold start from disk. Safari and Firefox are not measured.
- The suite runs the TypeScript sources through a production Vite build, not the published `dist`.

## Testing

```
pnpm test           # every suite once per Yjs major: node + real Chromium, Firefox and WebKit (Vitest browser mode); includes multi-tab live sync
pnpm test:node
pnpm test:browser   # first time: pnpm exec playwright install chromium firefox webkit
```

WebKit runs the browser suite with a profile on disk, because in Playwright's default context (like a Safari private window) OPFS fails; the `private-browsing` project runs `*.private-browsing.test.ts` in that default context to check the IndexedDB fallback. Every project exists once per Yjs major (`node-v13`, `node-v14`, `browser-v13`, …); `pnpm exec vitest run --project 'browser-v14 (webkit)'` runs one browser on one major.
