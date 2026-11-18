## Purpose

Keep a Yjs document on the device, in OPFS when the browser allows it, in IndexedDB otherwise, and on the filesystem in Node.

## Requirements

### Requirement: Load then save

A persistence SHALL apply the stored document to its `Y.Doc` before it resolves `whenSynced`, and store every later update not applied by itself.

- **Scenario: Reload**
  - **GIVEN** a document edited and persisted
  - **WHEN** the page reloads and a persistence opens the same name
  - **THEN** after `whenSynced` the document holds every edit

### Requirement: Backend fallback

Opening storage SHALL try backends in the given order (OPFS, then IndexedDB, then memory by default), use the first that works, and report which was used and why the others were skipped.

- **Scenario: No OPFS**
  - **GIVEN** a browser where OPFS cannot be used (insecure context, no worker, private browsing)
  - **WHEN** storage is opened with the default order
  - **THEN** IndexedDB is used and the skipped reason for OPFS is reported

### Requirement: Bounded log

A persistence SHALL compact its log once it exceeds its record or byte limit (500 records or 1 MiB by default).

- **Scenario: Many small edits**
  - **WHEN** 600 updates are written
  - **THEN** the log has been compacted at least once and still loads every edit

### Requirement: Clear data

Clearing a document's data SHALL remove it from storage so a new persistence on that name starts empty.

- **Scenario: Clear and reopen**
  - **WHEN** data is cleared and the document reopened
  - **THEN** it loads empty
