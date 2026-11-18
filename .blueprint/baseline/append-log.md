## Purpose

Store a document's Yjs updates as an append-only log that survives crashes, and define the storage contract backends implement.

## Requirements

### Requirement: Append and load

Updates appended to a document's log SHALL be returned, merged, when the log is loaded again.

- **Scenario: Reopen**
  - **GIVEN** a log with appended updates
  - **WHEN** a new log is opened on the same storage
  - **THEN** loading it yields a document equal to the one written

### Requirement: Crash-safe compaction

Compacting a log SHALL replace its records with one merged update such that a crash at any point leaves either the old or the new log readable, never neither.

- **Scenario: Crash during compaction**
  - **WHEN** a write is cut short while a compacted generation is being written
  - **THEN** the next open reads the previous generation with every update

### Requirement: Storage contract

A storage backend SHALL be usable by the log when it passes the conformance cases the package exports.

- **Scenario: New backend**
  - **WHEN** a backend author runs the conformance helper against their backend
  - **THEN** each case passes or names the contract rule broken

### Requirement: Invalid updates rejected

Appending bytes that are not a valid Yjs update SHALL fail without changing the log.

- **Scenario: Garbage append**
  - **WHEN** random bytes are appended
  - **THEN** an error is raised and the log loads as before
