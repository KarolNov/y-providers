import type { DocumentStore } from './types.js'
import type { ConformanceDocs } from './yjs.js'

/** What a conformance run needs from a backend under test. */
export interface ConformanceBackend {
  /** A new handle on the same underlying data: handles must see each other's appends. */
  open(): DocumentStore | Promise<DocumentStore>
  /** Called once per case after its handles are closed. */
  dispose?(): void | Promise<void>
}

/** A fresh, empty backend per call. */
export type ConformanceFactory = () => ConformanceBackend | Promise<ConformanceBackend>

export interface ConformanceCase {
  name: string
  run(): Promise<void>
}

/** Appends well past any backend's compaction or pagination threshold. */
const MANY = 300

function fail(message: string): never {
  throw new Error(`storage conformance: ${message}`)
}

/** One update per call, setting `key` to `value` in a map, from its own client. */
let nextClient = 1

function helpers(yjs: ConformanceDocs) {
  return {
    /** Applies what `load` resolved the way a caller does: every update, in one transaction. */
    toDoc(updates: Uint8Array[] | null, what: string) {
      if (!updates) fail(`${what}: load returned null`)
      if (!Array.isArray(updates)) fail(`${what}: load did not resolve an array`)
      return yjs.entries(updates)
    },
    // distinct clients, so two updates can never collide on a random clientID
    makeUpdate: (key: string, value: string) => yjs.entryUpdate(nextClient++, key, value),
    expectEntries(actual: Record<string, unknown>, expected: Record<string, string>, what: string) {
      const a = Object.keys(actual).sort()
      const e = Object.keys(expected).sort()
      if (a.length !== e.length) fail(`${what}: expected ${e.length} entries, got ${a.length}`)
      const bad = e.find((k, i) => k !== a[i] || actual[k] !== expected[k])
      if (bad !== undefined) {
        fail(`${what}: expected ${bad}=${expected[bad]}, got ${bad}=${String(actual[bad])}`)
      }
    },
  }
}

async function withBackend(
  factory: ConformanceFactory,
  body: (open: () => Promise<DocumentStore>) => Promise<void>,
) {
  const backend = await factory()
  const handles: DocumentStore[] = []
  let failure: { error: unknown } | undefined
  try {
    await body(async () => {
      const handle = await backend.open()
      handles.push(handle)
      return handle
    })
  } catch (error) {
    failure = { error }
  }
  // Release everything even when one close throws; the body's failure wins.
  for (const handle of handles) {
    try {
      await handle.close?.()
    } catch (error) {
      failure ??= { error }
    }
  }
  try {
    await backend.dispose?.()
  } catch (error) {
    failure ??= { error }
  }
  if (failure) throw failure.error
}

/**
 * The cases a backend must pass, as data, so any test runner can register them:
 *
 *     for (const c of conformanceCases(factory)) test(c.name, c.run)
 *
 * Import it from the entry for your Yjs major (`y-append-log` or `y-append-log/y14`).
 *
 * They assert behaviour only, never thresholds, row layout or key formats.
 */
export function conformanceCases(
  factory: ConformanceFactory,
  yjs: ConformanceDocs,
): ConformanceCase[] {
  const { toDoc, makeUpdate, expectEntries } = helpers(yjs)
  const cases: [string, (open: () => Promise<DocumentStore>) => Promise<void>][] = [
    [
      'load returns null for an unknown document',
      async (open) => {
        const store = await open()
        if ((await store.load('unknown')) !== null) fail('unknown document did not load as null')
      },
    ],
    [
      'load returns updates that apply to the merged document',
      async (open) => {
        const store = await open()
        await store.append('doc', makeUpdate('a', '1'))
        await store.append('doc', makeUpdate('b', '2'))
        await store.append('doc', makeUpdate('c', '3'))
        expectEntries(toDoc(await store.load('doc'), 'merge'), { a: '1', b: '2', c: '3' }, 'merge')
      },
    ],
    [
      'concurrent appends from one handle are all kept',
      async (open) => {
        const store = await open()
        await Promise.all(
          Array.from({ length: 20 }, (_, i) => store.append('doc', makeUpdate(`k${i}`, `v${i}`))),
        )
        const expected: Record<string, string> = {}
        for (let i = 0; i < 20; i++) expected[`k${i}`] = `v${i}`
        expectEntries(toDoc(await store.load('doc'), 'concurrent'), expected, 'concurrent')
      },
    ],
    [
      'concurrent appends from independent handles are all kept',
      async (open) => {
        const handles = [await open(), await open(), await open()]
        const expected: Record<string, string> = {}
        const writes: Promise<void>[] = []
        for (let i = 0; i < 30; i++) {
          expected[`k${i}`] = `v${i}`
          writes.push(handles[i % handles.length]!.append('doc', makeUpdate(`k${i}`, `v${i}`)))
        }
        await Promise.all(writes)
        expectEntries(toDoc(await handles[0]!.load('doc'), 'writers'), expected, 'writers')
      },
    ],
    [
      'a resolved append is visible to a load by an independent handle',
      async (open) => {
        const writer = await open()
        const reader = await open()
        const expected: Record<string, string> = {}
        for (let i = 0; i < 5; i++) {
          expected[`k${i}`] = `v${i}`
          await writer.append('doc', makeUpdate(`k${i}`, `v${i}`))
          expectEntries(
            toDoc(await reader.load('doc'), 'read-your-writes'),
            expected,
            `after ${i + 1}`,
          )
        }
      },
    ],
    [
      'documents with different names are isolated',
      async (open) => {
        const store = await open()
        await store.append('one', makeUpdate('a', '1'))
        await store.append('two', makeUpdate('b', '2'))
        expectEntries(toDoc(await store.load('one'), 'one'), { a: '1' }, 'one')
        expectEntries(toDoc(await store.load('two'), 'two'), { b: '2' }, 'two')
        await store.delete('one')
        expectEntries(
          toDoc(await store.load('two'), 'two after delete'),
          { b: '2' },
          'two after delete',
        )
      },
    ],
    [
      'delete removes the document and it can be written again',
      async (open) => {
        const store = await open()
        const other = await open()
        await store.append('doc', makeUpdate('a', '1'))
        await store.delete('doc')
        if ((await store.load('doc')) !== null) fail('deleted document still loads')
        if ((await other.load('doc')) !== null)
          fail('deleted document still loads by another handle')
        await store.delete('never-written')
        await store.append('doc', makeUpdate('b', '2'))
        expectEntries(toDoc(await other.load('doc'), 'rewritten'), { b: '2' }, 'rewritten')
      },
    ],
    [
      `${MANY} appends still load in full`,
      async (open) => {
        const store = await open()
        const expected: Record<string, string> = {}
        for (let i = 0; i < MANY; i++) {
          expected[`k${i}`] = `v${i}`
          await store.append('doc', makeUpdate(`k${i}`, `v${i}`))
        }
        expectEntries(toDoc(await store.load('doc'), 'many'), expected, 'many')
        await store.append('doc', makeUpdate('last', 'x'))
        expected.last = 'x'
        expectEntries(toDoc(await (await open()).load('doc'), 'many + one'), expected, 'many + one')
      },
    ],
  ]
  return cases.map(([name, body]) => ({ name, run: () => withBackend(factory, body) }))
}

/** Runs every case in order and throws on the first failure. For runners that want one call. */
export async function runConformance(
  factory: ConformanceFactory,
  yjs: ConformanceDocs,
): Promise<void> {
  for (const c of conformanceCases(factory, yjs)) {
    try {
      await c.run()
    } catch (error) {
      throw new Error(`"${c.name}" failed: ${error instanceof Error ? error.message : error}`, {
        cause: error,
      })
    }
  }
}
