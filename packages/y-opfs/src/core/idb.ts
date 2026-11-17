import type { Storage } from 'y-append-log/core'

/**
 * IndexedDB fallback. A "file" is a run of chunks keyed [name, seq]; append adds
 * a chunk, write replaces all chunks in one transaction. The byte length is
 * kept in a record at [name, -1] so `size()` does not have to read the data.
 */
export class IdbStorage implements Storage {
  readonly scope: string
  private db: Promise<IDBDatabase>
  private closed = false

  constructor(dbName = 'y-opfs') {
    this.scope = `idb:${dbName}`
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('chunks')
      req.onsuccess = () => {
        const db = req.result
        // Do not hold up deleteDatabase() or an upgrade from another tab.
        db.onversionchange = () => {
          this.closed = true
          db.close()
        }
        resolve(db)
      }
      req.onerror = () => reject(req.error)
    })
  }

  /** The open connection, or a rejection once it has been closed. */
  private async open() {
    const db = await this.db
    if (this.closed) throw new Error(`IdbStorage "${this.scope}" is closed`)
    return db
  }

  /**
   * Closes the connection so `indexedDB.deleteDatabase()` is not blocked by it.
   * Later calls reject; create a new `IdbStorage` to use the database again.
   */
  async close() {
    this.closed = true
    try {
      ;(await this.db).close()
    } catch {
      // The open itself failed, so there is no connection to close.
    }
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    fn: (s: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | undefined> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', mode)
      const req = fn(tx.objectStore('chunks'))
      tx.oncomplete = () => resolve(req ? req.result : undefined)
      onFailure(tx, reject)
    })
  }

  private range(name: string) {
    return IDBKeyRange.bound([name, 0], [name, Number.MAX_SAFE_INTEGER])
  }

  /** Chunks plus the size record. */
  private fileRange(name: string) {
    return IDBKeyRange.bound([name, -1], [name, Number.MAX_SAFE_INTEGER])
  }

  async read(name: string) {
    const chunks = (await this.tx('readonly', (s) => s.getAll(this.range(name)))) as Uint8Array[]
    if (!chunks || chunks.length === 0) return null
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of chunks) (out.set(c, at), (at += c.length))
    return out
  }

  async size(name: string) {
    const recorded = (await this.tx('readonly', (s) => s.get([name, -1]))) as number | undefined
    if (recorded !== undefined) return recorded
    // Data written before the size record existed.
    const chunks = (await this.tx('readonly', (s) => s.getAll(this.range(name)))) as Uint8Array[]
    if (!chunks || chunks.length === 0) return null
    return chunks.reduce((n, c) => n + c.length, 0)
  }

  async append(name: string, data: Uint8Array) {
    await this.appendChunk(name, data)
  }

  appendIfSize(name: string, data: Uint8Array, size: number) {
    return this.appendChunk(name, data, size)
  }

  /** Adds a chunk, in one transaction, unless `size` is given and the file is not that long. */
  private async appendChunk(name: string, data: Uint8Array, size?: number) {
    const db = await this.open()
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite')
      const store = tx.objectStore('chunks')
      // A request issued from a callback can throw; abort instead of leaving an
      // uncaught error. Once a site is over quota, Firefox refuses every later
      // write this way with an InvalidStateError ("a database that did not
      // allow mutations"), which is reported as the QuotaExceededError it is.
      let thrown: unknown
      const guard = (fn: () => void) => () => {
        try {
          fn()
        } catch (e) {
          thrown ??=
            (e as DOMException).name === 'InvalidStateError'
              ? new DOMException((e as DOMException).message, 'QuotaExceededError')
              : e
          tx.abort()
        }
      }
      let appended = false
      const meta = store.get([name, -1])
      const last = store.openCursor(this.range(name), 'prev')
      last.onsuccess = guard(() => {
        const seq = last.result ? (last.result.key as [string, number])[1] + 1 : 0
        const put = (before: number) => {
          // A file with no chunks does not exist, so it matches no size.
          if (size !== undefined && (!last.result || before !== size)) return
          store.put(data, [name, seq])
          store.put(before + data.length, [name, -1])
          appended = true
        }
        if (meta.result !== undefined || !last.result)
          return void put((meta.result as number | undefined) ?? 0)
        const existing = store.getAll(this.range(name))
        existing.onsuccess = guard(() =>
          put((existing.result as Uint8Array[]).reduce((n, c) => n + c.length, 0)),
        )
      })
      tx.oncomplete = () => resolve(appended)
      onFailure(tx, reject, () => thrown)
    })
  }

  async write(name: string, data: Uint8Array) {
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('chunks', 'readwrite')
      const store = tx.objectStore('chunks')
      store.delete(this.fileRange(name))
      store.put(data, [name, 0])
      store.put(data.length, [name, -1])
      tx.oncomplete = () => resolve()
      onFailure(tx, reject)
    })
  }

  async remove(name: string) {
    await this.tx('readwrite', (s) => {
      s.delete(this.fileRange(name))
    })
  }
}

/**
 * Rejects with the error that failed the transaction. A failed request's error
 * event reaches the transaction before the abort does, while `tx.error` is still
 * null, so the request's error is read from the event: over quota this is the
 * QuotaExceededError. `thrown` is an error raised by our own callback, which
 * aborted the transaction itself. With none of these, a plain AbortError.
 */
function onFailure(
  tx: IDBTransaction,
  reject: (e: unknown) => void,
  thrown = (): unknown => undefined,
) {
  tx.onerror = (event) =>
    reject(tx.error ?? thrown() ?? (event.target as IDBRequest | null)?.error ?? aborted())
  tx.onabort = () => reject(tx.error ?? thrown() ?? aborted())
}

const aborted = () => new DOMException('IndexedDB transaction aborted', 'AbortError')
