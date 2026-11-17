import { Doc, array, map, text } from '#y'
import { afterEach, describe, expect, it } from 'vitest'
import { IdbStorage, OpfsPersistence, WorkerStorage } from '#entry'
import type { PersistenceOptions, Storage } from '#entry'
import { lossy, until } from './channels.js'

const uid = () => `t${Math.random().toString(36).slice(2)}`
const newWorker = () => new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' })
const settle = () => new Promise((r) => setTimeout(r, 50))

describe('live sync between tabs (real BroadcastChannel)', () => {
  const workers: Worker[] = []
  afterEach(() => workers.splice(0).forEach((w) => w.terminate()))

  // Every simulated tab gets its own storage client, as separate tabs would.
  const backends = [
    [
      'OPFS',
      () => () => {
        const w = newWorker()
        workers.push(w)
        return new WorkerStorage(w)
      },
    ],
    [
      'IndexedDB',
      () =>
        (
          (db) => () =>
            new IdbStorage(db)
        )(uid()),
    ],
  ] as const

  for (const [label, makeOpen] of backends) {
    describe(label, () => {
      const open = makeOpen()
      const countReads = (storage: Storage) => {
        const counter = { reads: 0 }
        const read = storage.read.bind(storage)
        storage.read = (n) => (counter.reads++, read(n))
        return counter
      }
      async function tab(name: string, options: PersistenceOptions = {}) {
        const doc = new Doc()
        const storage = open()
        const reads = countReads(storage)
        const p = new OpfsPersistence(name, doc, storage, options)
        await p.whenSynced
        reads.reads = 0
        return { doc, p, reads }
      }

      it('three tabs converge live, without flushing or reloading', async () => {
        const name = uid()
        const tabs = await Promise.all([tab(name), tab(name), tab(name)])
        tabs.forEach((t, i) => array(t.doc, 'k').push([i]))
        await Promise.all(tabs.map((t) => t.p.flush()))
        await until(() => tabs.every((t) => array(t.doc, 'k').length === 3))
        const [first, ...rest] = tabs.map((t) => array(t.doc, 'k').toArray().sort())
        for (const r of rest) expect(r).toEqual(first)
        await Promise.all(tabs.map((t) => t.p.destroy()))
      })

      it('a receiving tab does not re-read the log before its next write', async () => {
        const name = uid()
        const a = await tab(name)
        const b = await tab(name)
        for (let i = 0; i < 5; i++) {
          array(a.doc, 'a').push([i])
          await a.p.flush()
          await until(() => array(b.doc, 'a').length === i + 1)
          array(b.doc, 'b').push([i])
          await b.p.flush()
          await until(() => array(a.doc, 'b').length === i + 1)
        }
        expect(a.reads.reads + b.reads.reads).toBe(0)
        await Promise.all([a.p.destroy(), b.p.destroy()])
      })

      it('stays in sync while both tabs compact constantly', async () => {
        const name = uid()
        const N = 40
        const a = await tab(name, { maxRecords: 3 })
        const b = await tab(name, { maxRecords: 3 })
        await Promise.all(
          [a, b].map(async (t, i) => {
            for (let n = 0; n < N; n++) {
              array(t.doc, `k${i}`).push([n])
              if (n % 2 === 0) await t.p.flush()
            }
            await t.p.flush()
          }),
        )
        const full = [...Array(N).keys()]
        await until(() =>
          [a, b].every((t) => [0, 1].every((i) => array(t.doc, `k${i}`).length === N)),
        )
        for (const t of [a, b])
          for (const i of [0, 1]) expect(array(t.doc, `k${i}`).toArray()).toEqual(full)
        await Promise.all([a.p.destroy(), b.p.destroy()])
      })

      it('a tab opened mid-stream loads the past, then follows live', async () => {
        const name = uid()
        const a = await tab(name, { maxRecords: 3 })
        for (let i = 0; i < 10; i++) {
          array(a.doc, 'k').push([i])
          await a.p.flush()
        }
        const late = await tab(name)
        expect(array(late.doc, 'k').length).toBe(10)
        array(a.doc, 'k').push([10])
        await a.p.flush()
        await until(() => array(late.doc, 'k').length === 11)
        array(late.doc, 'k').push([11])
        await late.p.flush()
        await until(() => array(a.doc, 'k').length === 12)
        await Promise.all([a.p.destroy(), late.p.destroy()])
      })

      it('a receiving tab neither persists nor broadcasts what it applied', async () => {
        const name = uid()
        const sender = lossy()
        const receiver = lossy()
        const a = await tab(name, { broadcast: sender })
        const b = await tab(name, { broadcast: receiver })
        text(a.doc, 't').insert(0, 'once')
        await a.p.flush()
        await until(() => text(b.doc, 't').toString() === 'once')
        await b.p.flush()
        await settle()
        expect(sender.state.posts).toBe(1)
        expect(receiver.state.posts).toBe(0)
        await Promise.all([a.p.destroy(), b.p.destroy()])
      })

      it("a lost broadcast is repaired by the next message, and by the receiver's own flush", async () => {
        const name = uid()
        const lose = lossy()
        const a = await tab(name, { broadcast: lose })
        const b = await tab(name)
        const c = await tab(name)

        lose.state.dropping = true
        array(a.doc, 'k').push(['lost'])
        await a.p.flush()
        await settle()
        expect(array(b.doc, 'k').length).toBe(0)

        // c's own write goes through the size check and picks up what it missed.
        array(c.doc, 'c').push([1])
        await c.p.flush()
        expect(array(c.doc, 'k').toArray()).toEqual(['lost'])

        // c's message does not continue from b's position, so b re-reads and finds both.
        await until(() => array(b.doc, 'k').length === 1 && array(b.doc, 'c').length === 1)

        lose.state.dropping = false
        await Promise.all([a.p.destroy(), b.p.destroy(), c.p.destroy()])
      })

      it('clearData in one tab detaches the others instead of letting them write their old doc back', async () => {
        const name = uid()
        const eventsB: string[] = []
        const a = await tab(name)
        const b = await tab(name, { onEvent: (e) => eventsB.push(e.type) })
        text(a.doc, 't').insert(0, 'old')
        await a.p.flush()
        await until(() => text(b.doc, 't').toString() === 'old')

        await a.p.clearData()
        await until(() => eventsB.includes('cleared'))
        text(b.doc, 't').insert(0, 'new ')
        await b.p.flush()

        const c = await tab(name)
        expect(text(c.doc, 't').toString()).toBe('')
        await c.p.destroy()
      })

      it('refresh() recovers a dropped message with no further traffic', async () => {
        const name = uid()
        const lose = lossy()
        const a = await tab(name, { broadcast: lose })
        const b = await tab(name)
        lose.state.dropping = true
        text(a.doc, 't').insert(0, 'quiet')
        await a.p.flush()
        await settle()
        expect(text(b.doc, 't').toString()).toBe('')
        await b.p.refresh()
        expect(text(b.doc, 't').toString()).toBe('quiet')
        await Promise.all([a.p.destroy(), b.p.destroy()])
      })
    })
  }
})
