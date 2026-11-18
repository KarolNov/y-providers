# Changelog

## 0.1.0

First release. The code comes from [y-modern](https://github.com/KarolNov/y-providers#where-this-came-from), my private Yjs playground.

- The per-document storage contract `DocumentStore` (`load`, `append`, `delete`, optional `close`), with every update in the Yjs v2 encoding.
- `ByteFileLog` and `ByteFileStore`: an append-only CRC log over a byte-file `Storage`, with crash-safe compaction into two generation slots. `MemoryStorage` and `MemoryDocumentStore` keep everything in memory.
- `conformanceCases` and `runConformance` for backend authors.
- Yjs v13 from `y-append-log`, Yjs v14 (`@y/y`) from `y-append-log/y14`, and `y-append-log/core` without Yjs for other providers.
