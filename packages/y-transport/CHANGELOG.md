# Changelog

## 0.1.0

First release. The code comes from [y-modern](https://github.com/KarolNov/y-providers#where-this-came-from), my private Yjs playground.

- `openTransport`: one connection per page for many documents, over WebTransport with WebSocket fallback, reconnect with backoff, application-level liveness pings and a versioned handshake (protocol 2).
- `SyncProvider`: sync of one document with v2 updates and presence, sent as datagrams over WebTransport.
- `SyncServer` with adapters for `ws` (`./server/ws`) and for WebTransport over `@fails-components/webtransport` (`./server/webtransport`), with `authorize` per document and any `DocumentStore` from `y-append-log`.
- Yjs v13 from `y-transport` and `y-transport/server`, Yjs v14 (`@y/y`, `@y/protocols`) from `y-transport/y14` and `y-transport/server/y14`. A v13 client and a v14 client cannot sync through one server.
- Experimental: no rate or size limits, no `wss://` tests, no hibernating server.
