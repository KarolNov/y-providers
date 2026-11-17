import type { Request, Response } from '../worker.js'

type Call = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never
import type { Storage } from 'y-append-log/core'

/** Main-thread proxy to an OPFS worker. */
export class WorkerStorage implements Storage {
  readonly scope: string
  private nextId = 0
  private failed: Error | null = null
  private calls = new Map<number, { resolve: (v: Response) => void; reject: (e: Error) => void }>()

  /** `directory` is the OPFS directory the worker serves (default of `serve`); it only scopes cross-tab broadcasts. */
  constructor(
    private readonly worker: Worker,
    directory = 'y-opfs',
  ) {
    this.scope = `opfs:${directory}`
    let answered = false
    worker.onmessage = (e: MessageEvent<Response>) => {
      answered = true
      this.calls.get(e.data.id)?.resolve(e.data)
      this.calls.delete(e.data.id)
    }
    // A worker that fails to load or throws at the top level never answers; fail its calls instead of hanging.
    // Once it has answered, a later error is left to the console: the worker still serves.
    worker.addEventListener('error', (e: ErrorEvent) => {
      if (answered) return
      this.failed = new Error(`OPFS worker failed${e.message ? `: ${e.message}` : ' to load'}`)
      for (const call of this.calls.values()) call.reject(this.failed)
      this.calls.clear()
    })
  }

  private call(
    req: Call,
    transfer: Transferable[] = [],
  ): Promise<Uint8Array | number | boolean | null | undefined> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (this.failed) return reject(this.failed)
      this.calls.set(id, {
        resolve: (r) => (r.ok ? resolve(r.data) : reject(toError(r))),
        reject,
      })
      this.worker.postMessage({ ...req, id }, transfer)
    })
  }

  async read(name: string) {
    return ((await this.call({ op: 'read', name })) as Uint8Array | null | undefined) ?? null
  }

  async size(name: string) {
    return ((await this.call({ op: 'size', name })) as number | null | undefined) ?? null
  }

  async append(name: string, data: Uint8Array) {
    const copy = data.slice() // transferring would detach the caller's buffer
    await this.call({ op: 'append', name, data: copy }, [copy.buffer])
  }

  async appendIfSize(name: string, data: Uint8Array, size: number) {
    const copy = data.slice()
    return (await this.call({ op: 'appendIfSize', name, data: copy, size }, [copy.buffer])) === true
  }

  async write(name: string, data: Uint8Array) {
    const copy = data.slice()
    await this.call({ op: 'write', name, data: copy }, [copy.buffer])
  }

  async remove(name: string) {
    await this.call({ op: 'remove', name })
  }

  close() {
    this.worker.terminate()
  }
}

/** Rebuilds the worker's error so callers can check `name` (e.g. 'QuotaExceededError'). */
function toError(r: { error: string; name?: string }): Error {
  if (!r.name) return new Error(r.error)
  return typeof DOMException === 'function'
    ? new DOMException(r.error, r.name)
    : Object.assign(new Error(r.error), { name: r.name })
}
