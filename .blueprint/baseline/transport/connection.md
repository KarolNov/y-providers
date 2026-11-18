## Purpose

Carry many documents between a client and a server over one connection, over WebTransport when it works and WebSocket when it does not.

## Requirements

### Requirement: One connection, many documents

A transport SHALL carry every document attached to it over one connection.

- **Scenario: Three documents**
  - **WHEN** three providers attach to one transport
  - **THEN** the server sees one connection carrying three documents

### Requirement: WebSocket fallback

In `auto` mode, when WebTransport is unsupported or fails to connect within the connect timeout (5 s by default), the transport SHALL connect over WebSocket, emit `fallback`, and not retry WebTransport until the retry window (5 min by default) has passed.

- **Scenario: UDP blocked**
  - **GIVEN** a network that drops UDP
  - **WHEN** the transport connects in `auto` mode
  - **THEN** documents sync over WebSocket and a `fallback` event is emitted

### Requirement: Reconnect with backoff

After a connection is lost, the transport SHALL reconnect with growing, jittered delays between the minimum and maximum backoff, and reattach every document.

- **Scenario: Server restart**
  - **WHEN** the server restarts
  - **THEN** the transport reconnects and every document syncs again

### Requirement: Dead connection detected

The transport SHALL ping at the ping interval and treat a connection silent for the idle timeout as lost.

- **Scenario: Silent network**
  - **WHEN** packets stop arriving without the connection closing
  - **THEN** the transport reports `disconnected` within the idle timeout and reconnects

### Requirement: Version handshake

Both sides SHALL open with a hello naming the protocol versions they support, and close the connection with a `ProtocolVersionError` when the ranges do not overlap.

- **Scenario: Old server**
  - **WHEN** a client meets a server whose versions do not overlap
  - **THEN** the client reports a `ProtocolVersionError` on every attempt, never syncs, and keeps retrying with backoff
