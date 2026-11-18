## Purpose

Share presence and cursors between clients without delaying document updates.

## Requirements

### Requirement: Cursors never delay edits

Over WebTransport, awareness updates that fit a datagram SHALL be sent as datagrams; departures and the first state on a connection SHALL go over the reliable stream.

- **Scenario: Lossy link**
  - **GIVEN** packet loss on a WebTransport connection
  - **WHEN** an awareness datagram is lost
  - **THEN** document updates are not delayed by it, and the next awareness update replaces it

### Requirement: Departures reach peers

When a provider is destroyed or its connection closes, other clients SHALL drop its awareness state.

- **Scenario: Tab closes**
  - **WHEN** a client disconnects
  - **THEN** the other clients no longer list its state
