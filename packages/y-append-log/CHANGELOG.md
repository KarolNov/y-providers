# Changelog

## 0.1.0

First release, extracted from y-modern.

- The per-document storage contract `DocumentStore` (`load`, `append`, `delete`, optional `close`), with every update in the Yjs v2 encoding.
- `ByteFileLog` and `ByteFileStore`: an append-only CRC log over a byte-file `Storage`, with crash-safe compaction into two generation slots. `MemoryStorage` and `MemoryDocumentStore` keep everything in memory.
- `conformanceCases` and `runConformance` for backend authors.
- Yjs v13 from `y-append-log`, Yjs v14 (`@y/y`) from `y-append-log/y14`, and `y-append-log/core` without Yjs for other providers.
