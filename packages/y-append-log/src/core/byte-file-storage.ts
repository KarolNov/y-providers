/** Minimal byte-file backend. Implementations: OPFS (worker), Node fs, in-memory. */
export interface Storage {
  /**
   * Identifies the underlying store (database, directory). Tabs only broadcast
   * to each other when this matches, so same-named documents in different
   * stores never exchange data. Leave unset to share one channel per name.
   */
  readonly scope?: string
  /** Whole file contents, or null if it does not exist. */
  read(name: string): Promise<Uint8Array | null>
  /** Byte length, or null if the file does not exist. Cheap; used to detect other writers. */
  size(name: string): Promise<number | null>
  append(name: string, data: Uint8Array): Promise<void>
  /**
   * Optional. Append `data` only if the file is exactly `size` bytes long, as
   * one operation, and resolve with whether it was appended. A missing file
   * never matches. Lets a writer check that nobody else wrote and append in a
   * single round trip; without it, `size()` and `append()` are called in turn.
   */
  appendIfSize?(name: string, data: Uint8Array, size: number): Promise<boolean>
  /** Replace the whole file and make it durable before resolving. */
  write(name: string, data: Uint8Array): Promise<void>
  remove(name: string): Promise<void>
  close?(): Promise<void> | void
}

let memoryCount = 0

export class MemoryStorage implements Storage {
  readonly scope = `memory:${memoryCount++}`
  readonly files = new Map<string, Uint8Array>()

  async read(name: string) {
    return this.files.get(name)?.slice() ?? null
  }

  async size(name: string) {
    return this.files.get(name)?.length ?? null
  }

  async append(name: string, data: Uint8Array) {
    const prev = this.files.get(name) ?? new Uint8Array(0)
    const next = new Uint8Array(prev.length + data.length)
    next.set(prev)
    next.set(data, prev.length)
    this.files.set(name, next)
  }

  async appendIfSize(name: string, data: Uint8Array, size: number) {
    if (this.files.get(name)?.length !== size) return false
    await this.append(name, data)
    return true
  }

  async write(name: string, data: Uint8Array) {
    this.files.set(name, data.slice())
  }

  async remove(name: string) {
    this.files.delete(name)
  }
}
