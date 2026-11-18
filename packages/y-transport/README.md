# y-transport

Part of [y-providers](../../README.md). Yjs sync over **WebTransport**, falling back to **WebSocket**, with a server for both (v0.1).

> **Status: experimental.** Tested in Node and in headless Chromium, Firefox and WebKit (Vitest browser mode with Playwright) against real WebTransport (HTTP/3) and WebSocket servers on 127.0.0.1. In Chromium and Firefox, with their native `WebTransport` and `WebSocket`, the tests check that two clients sync a document and awareness over each protocol, that a self-signed certificate is accepted when its hash is pinned and rejected when another hash is, that awareness renewals travel as datagrams from client to server and from server to client, that `auto` picks WebTransport and falls back to WebSocket when the WebTransport endpoint is unreachable, and that clients reconnect and merge offline edits after the server drops them. In Node only (a UDP relay is needed): a client whose path goes silent is dropped by the liveness check and reconnects, and a WebTransport session survives a change of the client's source port. Playwright's WebKit has no `WebTransport`, so there only the WebSocket tests run, plus one checking that `auto` goes straight to WebSocket. Not tested: Safari itself, a real network with packet loss, NAT or blocked UDP (on 127.0.0.1 an unreachable endpoint fails at once instead of timing out), `wss://` (a browser cannot pin a hash for a WebSocket, so it needs a trusted certificate), and a deployment behind a proxy or CDN. Packet loss and latency were only emulated, in the [benchmarks](#benchmarks). Every test runs once per Yjs major. Not addressed in 0.1.0: rate and size limits, and servers that hibernate (see [Known limitations](#known-limitations-v01)).

What it does:

- One connection per page, many documents over it (each frame names its document).
- Document updates go on one reliable stream (WebTransport) or the socket (WebSocket). Presence ([awareness](https://docs.yjs.dev/api/about-awareness)) updates go in datagrams where there are any, because a lost one is replaced by the next renewal. Departures and the first state on a new connection are not renewed, so they go reliably.
- Reconnects with backoff and re-syncs both ways. Edits made while offline are not queued; Yjs state exchange merges them on reconnect.
- Notices a dead connection itself: after `pingInterval` (default 15s) of silence the client sends a ping frame (type 3, empty document name) and the server answers with a pong (type 4); after `idleTimeout` (default three intervals) with nothing received, the client closes the link and reconnects. Any frame counts as proof of life, and the same check covers WebTransport and WebSocket. A browser cannot send WebSocket protocol-level pings, which is why this is an application frame. The server-side WebSocket heartbeat still exists for dead clients.
- Connection migration comes from QUIC, not from this code: a WebTransport session survives the client's address changing (a NAT rebinding, Wi-Fi to cellular) because QUIC identifies connections by ID, not by address. A test routes a client through a UDP relay and moves it to a new source port mid-session; the session stays up with no reconnect and edits flow both ways. That checks the server side (`@fails-components/webtransport`) and the client in Node; whether a browser actually moves the connection when the OS changes network is up to the browser and is not tested. A WebSocket is TCP and cannot migrate: it drops and reconnects.

## Yjs v13 and v14

The main entry is for Yjs v13 (`yjs`). For Yjs v14 (`@y/y`, currently a release candidate) import the `/y14` entry instead; the API is the same.

```ts
import { ... } from 'y-transport' // yjs ^13.6
import { ... } from 'y-transport/y14' // @y/y >=14.0.0-rc.30
```

Each entry loads only its own Yjs, so an app never bundles both. Install the one you use: Yjs is an optional peer dependency. The `/y14` entry needs Node 22 or later, like `@y/y`. The server has the same split: `y-transport/server` for v13 and `y-transport/server/y14` for v14; `./server/ws` and `./server/webtransport` hold no Yjs and serve both. The v13 entries use `y-protocols` for awareness, the v14 ones `@y/protocols`.

A v13 client and a v14 client syncing through one server is **not supported** in 0.1.0: run the server on the same major as its clients. The wire protocol is the same for both.

## Client

```ts
import * as Y from 'yjs'
import { SyncProvider, openTransport } from 'y-transport'

const transport = openTransport({
  webTransportUrl: 'https://sync.example.com:4433/sync',
  websocketUrl: 'wss://sync.example.com/sync',
})
const doc = new Y.Doc()
const provider = new SyncProvider('my-doc', doc, transport)
await provider.whenSynced
provider.awareness?.setLocalState({ name: 'Ann' })
```

Choose a protocol with `mode` (default `'auto'`):

```ts
openTransport({ webTransportUrl, websocketUrl }) // 'auto'
openTransport({ mode: 'websocket', websocketUrl }) // WebSocket only
openTransport({ mode: 'webtransport', webTransportUrl }) // WebTransport only, throws if unsupported
```

`auto` uses WebTransport when the runtime has it and `webTransportUrl` is set. If a WebTransport connection cannot be made (blocked UDP, a proxy in the way, no server) it uses the WebSocket for that attempt, emits a `fallback` event, and stays on WebSocket for `webTransportRetryAfter` (default 5 minutes) before trying WebTransport again. A WebTransport connection that was working and then drops is retried as WebTransport. Bad configurations throw in `openTransport`, not later.

`transport.kind` is the protocol in use (`'webtransport' | 'websocket' | null`), `transport.status` the state, and `transport.subscribe(fn)` delivers `connecting`, `connected`, `disconnected`, `fallback` and `error` events. `webTransportSupported()` tells you whether the runtime has it. In Node pass `WebTransport` from `@fails-components/webtransport` as an option; Node 22+ has a global `WebSocket`.

For a self-signed development certificate, pass `webTransportOptions: { serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }] }`, with `hash` the SHA-256 of the DER certificate as a `Uint8Array` or `ArrayBuffer` (Chromium does not accept a hex string or a plain array).

`provider.destroy()` stops syncing that document and tells others the presence is gone; `transport.close()` closes the connection. Closing the transport is separate so that a framework's double mount does not tear down a shared connection.

## Server: `y-transport/server`

`SyncServer` holds the documents and is independent of the protocol. Adapters feed it connections:

```ts
import { WebSocketServer } from 'ws'
import { SyncServer } from 'y-transport/server'
import { attachWebSocketServer } from 'y-transport/server/ws'
import { serveWebTransport } from 'y-transport/server/webtransport'

const server = new SyncServer({
  storage, // optional, see below
  authorize: (doc, context) => canOpen(doc, context), // optional; context is the HTTP request or the WebTransport session
})
attachWebSocketServer(server, new WebSocketServer({ port: 1234 }))
await serveWebTransport(server, { port: 4433, cert, privKey }) // PEM strings
```

Adapters are separate entry points so you only install what you use. `ws` is needed for the WebSocket adapter. The WebTransport adapter needs `@fails-components/webtransport` and its prebuilt QUIC binary, `@fails-components/webtransport-transport-http3-quiche`, which has binaries for Linux, macOS and Windows on x64 and, for Linux and macOS, arm. WebTransport is HTTP/3, so it needs a UDP port and a certificate that browsers accept: CA-signed, or self-signed with at most 14 days of validity and pinned by the client as above.

Because the sync logic only sees a `Link` (a frame pipe), a Cloudflare Worker or Deno server can reuse `SyncServer` by wrapping its own sockets in a `Link`.

**Storage.** `storage` takes any `DocumentStore` from [`y-append-log`](../y-append-log/README.md): `load`, `append`, `delete` and an optional `close`. The server calls `load` once when a document is first opened and applies the updates it resolves in one transaction, then calls `append` with every update it accepts, in order. Updates go both ways in the Yjs v2 encoding (`Y.encodeStateAsUpdateV2`, the doc's `updateV2` event). `close()` on the server closes the store. Compaction is the store's job. `MemoryDocumentStore` from `y-append-log` keeps documents in memory; `ByteFileStore` from `y-append-log` over `NodeFsStorage` from `y-opfs/node` keeps them on disk; or write your own against the contract. A document is freed `evictAfter` ms after its last connection leaves (or sends a leave frame for it); a connection that comes back first keeps it. With `storage` the default is 30s, and a freed document is loaded again on the next open. Without `storage` the default is never, because the server's memory is the only copy. Set `evictAfter` anyway to stop idle documents from piling up when the server is a relay rather than the record: a freed document is gone from the server, and it comes back only when a client that still holds it syncs again (the state exchange sends the server everything it lacks). A client that never had it gets an empty document.

```ts
import { MemoryDocumentStore } from 'y-append-log'
import { SyncServer } from 'y-transport/server'

const server = new SyncServer({ storage: new MemoryDocumentStore() })
```

## Protocol

Frames are `varString(document) varUint(type) payload`, with type 0 a sync message laid out as in [y-protocols](https://github.com/yjs/y-protocols) (step 1, step 2, update) but with every update in the Yjs v2 encoding, 1 awareness, and 2 leave (the client stopped syncing that document but keeps the connection). On WebSocket each frame is one binary message. On WebTransport the client opens one bidirectional stream carrying length-prefixed frames (an empty frame first, because QUIC streams are invisible to the peer until they carry data), and awareness frames go in datagrams when they fit. The server sends datagrams the same way.

Before any frame, each side sends a hello, `0xff varString('y-modern') varUint(min) varUint(max)` (the magic string is a leftover name from [y-modern](https://github.com/KarolNov/y-providers#where-this-came-from), my private Yjs playground, kept so the hello layout stays frozen): the range of protocol versions it speaks (`MIN_PROTOCOL_VERSION` to `PROTOCOL_VERSION`, exported along with the `VersionRange` type; this release: 2 to 2; version 1 carried v1 updates and is no longer spoken). The hello layout is frozen, so any two releases can read each other's. The client sends first and waits for the server's; the server answers every hello with its own and, if the ranges do not overlap, closes the connection. The client then reports an `error` event whose `error` is a `ProtocolVersionError`, with `local` and `remote` ranges, and keeps retrying with backoff, since the server may be upgraded under it. `remote` is null when the server sent no hello within `connectTimeout` or answered with something else. A server from before the handshake is one of those: the leading `0xff` makes it drop the hello as a malformed frame, without authorizing or opening anything, and stay silent. A server that has stopped answering looks the same. Neither makes `auto` fall back to WebSocket: the connection to the server works, and the other protocol reaches the same server. A connection whose first message is not a hello is closed, and so is one that sends nothing for `helloTimeout` (a `SyncServer` option, default 10 s). A later release that changes the frame format raises `PROTOCOL_VERSION` and can keep speaking older versions by keeping them in its range.

## Benchmarks

Earlier measurements, made in [y-modern](https://github.com/KarolNov/y-providers#where-this-came-from), my private Yjs playground, where the benchmark harness lives (it isn't part of y-providers). The code measured is the code in this package; only package names and the Yjs adapter changed since. They were taken with Yjs v13.

The harness compared WebTransport with WebSocket for the same `SyncServer`, with Node clients and in headless Chromium, on loopback and under two emulated networks: `wan` (40 ms RTT ±10 ms, 50 Mbit/s) and `lossy` (the same plus 2% loss each way), made with Linux `tc`/`netem` on the server's ports. The rate limit is one queue shared by both directions and every client. Cases: edit latency, throughput, initial sync of a ~1 MB document, connect, small edits to other documents while a large update is in flight, presence (latency and updates lost), reconnect after the server drops the connection, and the server's memory and CPU.

What a run on a GitHub runner (2026-10-04, 2-core AMD EPYC) showed:

- **On loopback WebSocket wins.** In Node a 100 B edit takes 0.32 ms against 0.57 ms, a 256 KB edit 4.9 ms against 15.4 ms, and 20 edits of 64 KB 15 ms against 75 ms. In Chromium small edits are even (0.8 against 0.7 ms) and large ones still favour WebSocket (15 against 29 ms for 256 KB).
- **On `wan` small messages are a few ms faster over WebTransport** (100 B edit 40 against 43 ms; reconnect 200 against 235 ms), while a single 256 KB edit is faster over WebSocket (161 against 319 ms in Node, 188 against 234 ms in Chromium). Throughput for 1.25 MB of edits is even.
- **Under loss WebTransport wins clearly** for anything large: a 256 KB edit takes 1.26 to 1.33 s against about 1.7 s, 1.25 MB of edits 2.4 s against 3.7 s in Chromium, and small edits behind a 1 MB update 3.4 s against 5.7 s. Every document shares one stream, so this is QUIC's loss recovery, not the absence of head-of-line blocking between documents.
- **Presence over datagrams can be lost**: 1.7 to 5% of updates at 30 per second never arrived under 2% loss, where a WebSocket delivered all of them. Latency of the ones that arrived is the same.
- **Connect** is slightly faster over WebSocket (175 against 184 ms on `wan`), but the WebSocket here is plain `ws://`; `wss://` adds a TLS round trip.
- **The server pays more for WebTransport**: about 180 kB of resident memory per connection against 42 kB, and 1.3 to 2.4 times the CPU time to relay small edits, depending on the machine (for 1000 edits of 100 B: 240 against 101 ms on an AMD EPYC 7763 runner, 62 against 47 ms on an Apple M1). Per document the cost is the same (about 21 kB).

## Tests

`pnpm test:node` runs the Node tests; the WebTransport client there is `@fails-components/webtransport`. `pnpm test:browser` runs `src/__tests__/browser/*.browser.test.ts` in headless Chromium, Firefox and WebKit; Every project exists once per Yjs major; `pnpm exec vitest run --project 'browser-v14 (firefox)'` in this package runs one browser on one major. WebTransport tests are reported as skipped in a browser without WebTransport, and a first test fails if a browser's support changes from what is expected. A Vitest global setup starts one `SyncServer` of the project's Yjs major with both adapters in Node and hands the browser its URLs and the certificate hash through `provide`/`inject`; a browser command (`dropConnections`) lets a test close the server's connections. Run `pnpm exec playwright install chromium firefox webkit` once first.

## Known limitations (v0.1)

- No authentication beyond `authorize`, no rate limits, no per-document or per-message size limits, no `wss://` tests, and no server that can hibernate (Durable Objects). These are known gaps; treat 0.1.0 as experimental.
- No offline queue beyond what Yjs state exchange gives you, and no persistence on the client; combine it with [`y-opfs`](../y-opfs/README.md) (the two do not depend on each other).
- Pings are part of every protocol version, so any server that passes the handshake answers them. A server of your own that wraps its sockets in a `Link` without `SyncServer` has to answer them too, or a quiet connection is closed and reopened every `idleTimeout`; `pingInterval: 0` turns the check off.

## Versioning

Package semver plus [CHANGELOG.md](CHANGELOG.md).
