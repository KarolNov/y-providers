## Purpose

Keep a document identical between clients through a server, sending only what the other side lacks.

## Requirements

### Requirement: Catch-up sends only what is missing

On every (re)attach, client and server SHALL exchange state vectors and send only the updates the other side lacks.

- **Scenario: Offline edits on both sides**
  - **GIVEN** a client that edited offline while another client also edited
  - **WHEN** it reconnects
  - **THEN** both hold every edit and neither sent its full state

### Requirement: Synced state

A provider SHALL report `synced` once its first catch-up with the server completes, and resolve `whenSynced` then.

- **Scenario: First load**
  - **WHEN** a provider attaches to a document the server holds
  - **THEN** `whenSynced` resolves after the server's state is applied

### Requirement: No echo

A provider SHALL not send back updates it applied from the server.

- **Scenario: Remote edit**
  - **WHEN** an update arrives from the server
  - **THEN** the provider sends nothing for it
