# Basic example

A shared list in the browser, kept on the device with [`y-opfs`](../../packages/y-opfs) and synced through a Node server with [`y-transport`](../../packages/y-transport). The status line shows which storage backend (OPFS or IndexedDB) and which transport (WebTransport or WebSocket) the page ended up with.

This package is private and is not published.

## Run it

From the repository root, with Node 22.18 or later and `openssl` on the path:

```sh
pnpm install
pnpm build
pnpm --filter y-providers-example-basic dev
```

`dev` starts the sync server and Vite in one process and prints the page's URL (usually <http://localhost:5173>). Open it in two tabs, and in a second browser: an item added in one shows up in the others. Reload with the server stopped and the list is still there, read from the device.

What it showed when tried on macOS:

| Browser                          | Storage   | Transport    |
| -------------------------------- | --------- | ------------ |
| Chromium, Firefox                | OPFS      | WebTransport |
| Playwright's WebKit (not Safari) | IndexedDB | WebSocket    |

`openStorage` falls back to IndexedDB when OPFS cannot be opened, and `openTransport` falls back to WebSocket when the browser has no `WebTransport` or cannot reach the server over UDP.

## What runs

- [`server.ts`](server.ts): one `SyncServer` behind two adapters, `ws` on TCP port 1234 and WebTransport on UDP port 4433, both on 127.0.0.1. It makes a self-signed certificate at startup (WebTransport needs TLS) and serves the endpoints and the certificate's SHA-256 at `GET http://127.0.0.1:1234/config`; the page pins that hash. The server keeps documents in memory only: each browser has its own copy, and a restarted server gets the document back from the first client that reconnects. A restarted server has a new certificate, so reload open pages to go back to WebTransport. `pnpm --filter y-providers-example-basic server` runs the server alone.
- [`src/main.ts`](src/main.ts): opens the storage, restores the document with `OpfsPersistence`, then connects a `SyncProvider`.
- [`src/ui.ts`](src/ui.ts): the list, the status line and the `/config` fetch, with no Yjs in it.

## Yjs v14

```sh
pnpm --filter y-providers-example-basic dev:y14
```

This runs the server on `y-transport/server/y14` and serves [`src/main.y14.ts`](src/main.y14.ts) instead of `src/main.ts`. The two differ only in their imports and in how they get the list:

```diff
-import * as Y from 'yjs'
-import { OpfsPersistence, openStorage } from 'y-opfs'
-import { SyncProvider, openTransport } from 'y-transport'
+import * as Y from '@y/y'
+import { OpfsPersistence, openStorage } from 'y-opfs/y14'
+import { SyncProvider, openTransport } from 'y-transport/y14'

-bindList(doc.getArray<string>('items'))
+bindList(doc.get('items'))
```

A v13 page cannot sync through a v14 server, or the other way round; the page reports a mismatch.
