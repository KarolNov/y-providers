# y-providers

Yjs providers that work with both Yjs v13 and Yjs v14:

| Package                                 | What it does                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`y-opfs`](packages/y-opfs)             | Keeps a document on the device: an append-only log on OPFS, with IndexedDB fallback, live sync between tabs, and a Node filesystem adapter.                          |
| [`y-transport`](packages/y-transport)   | Syncs documents with a server over WebTransport, falling back to WebSocket, many documents per connection, with presence. Includes a Node server for both protocols. |
| [`y-append-log`](packages/y-append-log) | The append-only, crash-safe update log and the storage contract the other two build on.                                                                              |

> **Status: experimental (0.1.0).** `y-transport` has no rate or size limits and no hibernating server yet.

## Yjs v13 and v14

Every package has the same API for both majors, chosen by the import path:

```ts
// Yjs v13: yjs, y-protocols
import { OpfsPersistence } from 'y-opfs'
import { SyncProvider, openTransport } from 'y-transport'
import { SyncServer } from 'y-transport/server'

// Yjs v14: @y/y, @y/protocols
import { OpfsPersistence } from 'y-opfs/y14'
import { SyncProvider, openTransport } from 'y-transport/y14'
import { SyncServer } from 'y-transport/server/y14'
```

- Each entry loads only its own major's packages, so an app never bundles both Yjs copies. Yjs is an optional peer dependency: install the one you use.
- The `/y14` entries need Node 22 or later, like `@y/y`. They are tested against `@y/y` 14.0.0-rc.30, and CI also runs against the newest release candidate.
- Mixing majors is **not supported** in 0.1.0: a v13 client and a v14 client cannot sync through one server. Run the server on the same major as its clients.

## Example

[`examples/basic`](examples/basic) is a shared list in the browser, stored with `y-opfs` and synced through a Node `SyncServer` with `y-transport`, on Yjs v13 or v14. After `pnpm install` and `pnpm build`:

```sh
pnpm --filter y-providers-example-basic dev
```

## Development

```sh
pnpm install
pnpm build
pnpm check:entries   # each built entry reaches only its own Yjs major
pnpm typecheck
pnpm test:node       # every suite once per Yjs major
pnpm exec playwright install chromium firefox webkit
pnpm test:browser
```

Specs and plans for this repo are kept with [blueprint](.blueprint/README.md).

## License

MIT
