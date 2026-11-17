import { appendFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Storage } from 'y-append-log/core'

/** Filesystem backend for Node/Bun/Electron: one directory, one file per log slot. */
export class NodeFsStorage implements Storage {
  readonly scope: string
  private ready: Promise<unknown>

  constructor(private readonly dir: string) {
    this.scope = `fs:${resolve(dir)}`
    this.ready = mkdir(dir, { recursive: true })
  }

  async read(name: string) {
    await this.ready
    try {
      return new Uint8Array(await readFile(join(this.dir, name)))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  async size(name: string) {
    await this.ready
    try {
      return (await stat(join(this.dir, name))).size
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  async append(name: string, data: Uint8Array) {
    await this.ready
    await appendFile(join(this.dir, name), data)
  }

  async write(name: string, data: Uint8Array) {
    await this.ready
    const path = join(this.dir, name)
    const tmp = `${path}.tmp`
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
  }

  async remove(name: string) {
    await this.ready
    await rm(join(this.dir, name), { force: true })
  }
}
