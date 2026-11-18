## Purpose

Accept connections over WebSocket and WebTransport in Node, relay updates between clients of a document, and keep documents in a store.

## Requirements

### Requirement: Relay between clients

The server SHALL apply each client's updates to its copy of the document and forward them to every other client of that document.

- **Scenario: Two clients**
  - **WHEN** one client edits a document another client has open
  - **THEN** the other client receives the edit

### Requirement: Authorize per document

The server SHALL call `authorize` for each document a connection attaches, and refuse the document when it rejects.

- **Scenario: Forbidden document**
  - **WHEN** `authorize` rejects a document
  - **THEN** the client is refused that document and its other documents keep syncing

### Requirement: Persist through a store

With a `DocumentStore`, the server SHALL load a document from it on first attach, store its updates, and evict it from memory once no client has had it open for the eviction delay.

- **Scenario: Server restart with a store**
  - **GIVEN** a server with a store and an edited document
  - **WHEN** the server restarts and a client attaches
  - **THEN** the client receives the stored document

### Requirement: Node adapters

The server SHALL accept WebSocket connections through an attached `ws` server and WebTransport sessions through an HTTP/3 server, both feeding the same `SyncServer`.

- **Scenario: One WebSocket and one WebTransport client**
  - **WHEN** one client connects over each
  - **THEN** they sync the same document through one server
