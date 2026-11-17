# Changelog

## 0.1.0

First release, extracted from y-modern.

- `OpfsPersistence`: a Yjs document kept in an append-only log on OPFS (from a worker), IndexedDB or memory, with crash-safe compaction, Web Locks between tabs, live sync between tabs over `BroadcastChannel`, and events.
- `openStorage` tries OPFS, then IndexedDB, and reports what it skipped. `y-opfs/node` has `NodeFsStorage`; `y-opfs/worker` is the OPFS worker.
- Yjs v13 from `y-opfs`, Yjs v14 (`@y/y`) from `y-opfs/y14`.
- Experimental.
