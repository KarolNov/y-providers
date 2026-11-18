# y-providers

Yjs providers that work with both Yjs v13 and Yjs v14:

| Package                                 | What it does                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`y-opfs`](packages/y-opfs)             | Keeps a document on the device: an append-only log on OPFS, with IndexedDB fallback, live sync between tabs, and a Node filesystem adapter.                          |
| [`y-transport`](packages/y-transport)   | Syncs documents with a server over WebTransport, falling back to WebSocket, many documents per connection, with presence. Includes a Node server for both protocols. |
| [`y-append-log`](packages/y-append-log) | The append-only, crash-safe update log and the storage contract the other two build on.                                                                              |

> **Status: experimental (0.1.0).** `y-transport` has no rate or size limits and no hibernating server yet.

## Why this exists

This is mostly an exercise for me: a way to see, in working code, what actually changes between Yjs v13 and the v14 release candidate. The answer so far is "less than the new package names suggest": every update and awareness function these providers use is the same, and the wire formats are unchanged, but the document API is different (`doc.get(name)` with attributes instead of `getMap`/`getText`). Each package keeps a version-free core and wires in one Yjs major per entry point, so the two majors sit side by side and the same tests run against both.

The packages are real and tested, but treat them as a study first and a dependency second.

## Where this came from

The code started in y-modern, my private Yjs playground. It was meant to become a public open-source library, but it grew bigger than I could finish as one project, so it never shipped. I'm splitting the parts that work into smaller public projects instead: the local persistence and network sync are here, the Jotai atoms over a `Y.Doc` are in [duratom](https://github.com/KarolNov/duratom), and more may follow.

A few traces of that name are left on purpose, because changing them would break stored data or the wire format: the `y-modern` magic string in the `y-transport` handshake, and the `y-modern:` prefix on the Web Lock and `BroadcastChannel` names. The benchmark and durability numbers in the package READMEs were also measured there, with Yjs v13, using a harness that isn't copied here.

## Yjs v13 and v14

Every package has the same API for both majors, chosen by the import path:

```ts
// Yjs v13: yjs, y-protocols
import { OpfsPersistence } from 'y-opfs'
import { SyncProvider, openTransport } from 'y-transport'
import { SyncServer } from 'y-transport/server'

// Yjs v14: @y/y, @y/protocols
import { OpfsPersistence } from 'y-opfs/y14'
import { SyncProvider, openTransport } from 'y-transport/y14'
import { SyncServer } from 'y-transport/server/y14'
```

- Each entry loads only its own major's packages, so an app never bundles both Yjs copies. Yjs is an optional peer dependency: install the one you use.
- The `/y14` entries need Node 22 or later, like `@y/y`. They are tested against `@y/y` 14.0.0-rc.30, and CI also runs against the newest release candidate.
- Mixing majors is **not supported** in 0.1.0: a v13 client and a v14 client cannot sync through one server. Run the server on the same major as its clients.

## Development

```sh
pnpm install
pnpm build
pnpm check:entries   # each built entry reaches only its own Yjs major
pnpm typecheck
pnpm test:node       # every suite once per Yjs major
pnpm exec playwright install chromium firefox webkit
pnpm test:browser
```

## Specs and blueprints

The `.blueprint/` folder and the "capabilities" it mentions come from [blueprint](https://github.com/KarolNov/skills#blueprint), a Claude Code skill I wrote for planning larger changes. The workflow:

- Each **capability** (for example `transport/connection` or `opfs/cross-tab`) has a short spec: requirements written as SHALL statements, each with GIVEN/WHEN/THEN scenarios. It describes behavior anyone can observe, not how the code does it.
- A **blueprint** is one planned change: what it decides, the requirements it adds or changes, and its tasks. This repo was built from one, "Extract y-providers from y-modern".
- When the change is built, its requirements are folded into the capability specs, and `.blueprint/blueprint.json` records which files implement each capability. `python3 .blueprint/drift.py check` then shows which capabilities have code that changed since their spec was last checked against it.

The specs and blueprints themselves live in my Notion, which isn't public. A copy of each spec as of its last sync is in [`.blueprint/baseline/`](.blueprint/baseline), so you can read them there.

## License

MIT
