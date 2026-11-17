import type { Storage } from 'y-append-log/core'

/**
 * OPFS backend built on synchronous access handles, which only exist inside a
 * Worker. Handles are opened per operation and released immediately: they take
 * an exclusive lock, so holding one would break every other tab. Contention is
 * retried briefly. File handles are not cached either: in Chromium a handle to
 * a file another tab removed still opens, and reports a nonsense size.
 */
export class OpfsStorage implements Storage {
  private root: Promise<FileSystemDirectoryHandle> | null = null

  constructor(private readonly directory = 'y-opfs') {}

  /** The directory handle. A failed open is not cached, so the next call tries again. */
  private dir() {
    if (!this.root) {
      const root = navigator.storage
        .getDirectory()
        .then((r) => r.getDirectoryHandle(this.directory, { create: true }))
      root.catch(() => {
        if (this.root === root) this.root = null
      })
      this.root = root
    }
    return this.root
  }

  private async withHandle<T>(
    name: string,
    create: boolean,
    fn: (h: FileSystemSyncAccessHandle) => T,
  ): Promise<T | null> {
    const dir = await this.dir()
    let file: FileSystemFileHandle
    try {
      file = await dir.getFileHandle(name, { create })
    } catch (e) {
      if ((e as DOMException).name === 'NotFoundError') return null
      throw e
    }
    for (let attempt = 0; ; attempt++) {
      let handle: FileSystemSyncAccessHandle
      try {
        handle = await file.createSyncAccessHandle()
      } catch (e) {
        if ((e as DOMException).name === 'NoModificationAllowedError' && attempt < 50) {
          await new Promise((r) => setTimeout(r, 10 + attempt * 5))
          continue
        }
        throw e
      }
      try {
        return fn(handle)
      } finally {
        handle.close()
      }
    }
  }

  read(name: string) {
    return this.withHandle(name, false, (h) => {
      const out = new Uint8Array(h.getSize())
      h.read(out, { at: 0 })
      return out
    })
  }

  size(name: string) {
    return this.withHandle(name, false, (h) => h.getSize())
  }

  async append(name: string, data: Uint8Array) {
    await this.withHandle(name, true, (h) => appendAt(h, name, data, h.getSize()))
  }

  async appendIfSize(name: string, data: Uint8Array, size: number) {
    const appended = await this.withHandle(name, false, (h) => {
      if (h.getSize() !== size) return false
      appendAt(h, name, data, size)
      return true
    })
    return appended ?? false
  }

  /**
   * Writes over the old contents and then cuts the file to length, rather than
   * truncating first, so a failed rewrite of the same bytes (torn-tail repair)
   * leaves the file as it was. A failed write to an empty file (a compaction
   * target) leaves it empty.
   */
  async write(name: string, data: Uint8Array) {
    await this.withHandle(name, true, (h) => {
      const before = h.getSize()
      const written = h.write(data, { at: 0 })
      if (written !== data.length) {
        if (before === 0) h.truncate(0)
        h.flush()
        throw shortWrite(name, written, data.length)
      }
      h.truncate(data.length)
      h.flush()
    })
  }

  async remove(name: string) {
    const dir = await this.dir()
    try {
      await dir.removeEntry(name)
    } catch (e) {
      if ((e as DOMException).name !== 'NotFoundError') throw e
    }
  }
}

/** Writes `data` at `end`, the file's length, and flushes; rolls back a short write. */
function appendAt(h: FileSystemSyncAccessHandle, name: string, data: Uint8Array, end: number) {
  const written = h.write(data, { at: end })
  if (written !== data.length) {
    h.truncate(end)
    h.flush()
    throw shortWrite(name, written, data.length)
  }
  h.flush()
}

/**
 * Firefox does not throw when a write goes over quota: it writes what fits and
 * returns the shorter count. Treated as the QuotaExceededError other engines throw.
 */
function shortWrite(name: string, written: number, wanted: number) {
  return new DOMException(
    `${name}: wrote ${written} of ${wanted} bytes (storage quota exceeded?)`,
    'QuotaExceededError',
  )
}
