## Purpose

Every package works with Yjs v13 and Yjs v14 through the same API, chosen by the import path.

## Requirements

### Requirement: Entry per major

Every package SHALL offer the same API from its main entry for Yjs v13 (`yjs`) and from its `/y14` entry for Yjs v14 (`@y/y`).

- **Scenario: v14 app**
  - **GIVEN** an app with `@y/y` and `@y/protocols` installed and neither `yjs` nor `y-protocols`
  - **WHEN** it imports a package's `/y14` entry and uses it with its `Y.Doc`
  - **THEN** it loads, persists and syncs that document

### Requirement: One Yjs per entry

An entry SHALL load only its own major's Yjs packages and never the other major's.

- **Scenario: v13 app**
  - **WHEN** an app using only the main entries is bundled
  - **THEN** the bundle contains no `@y/y` or `@y/protocols` code, and no "Yjs was already imported" warning appears

### Requirement: Mixed majors not promised

Syncing a v13 client with a v14 client SHALL be documented as unsupported.

- **Scenario: Reading the docs**
  - **WHEN** a reader looks for v13/v14 interop in the README
  - **THEN** it says mixed-version sync is not supported in 0.1.0
