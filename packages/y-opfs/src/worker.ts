/// <reference lib="webworker" />
import { OpfsStorage } from './core/opfs.js'

/** Worker entry: serves a Storage over postMessage. Spawned by `WorkerStorage`. */
export type Request =
  | { id: number; op: 'read' | 'remove' | 'size'; name: string }
  | { id: number; op: 'append' | 'write'; name: string; data: Uint8Array }
  | { id: number; op: 'appendIfSize'; name: string; data: Uint8Array; size: number }

export type Response =
  | { id: number; ok: true; data?: Uint8Array | number | boolean | null }
  | { id: number; ok: false; error: string; name?: string }

export function serve(scope: DedicatedWorkerGlobalScope, directory?: string) {
  const storage = new OpfsStorage(directory)
  scope.onmessage = async (event: MessageEvent<Request>) => {
    const msg = event.data
    try {
      let data: Uint8Array | number | boolean | null | undefined
      if (msg.op === 'read') data = await storage.read(msg.name)
      else if (msg.op === 'size') data = await storage.size(msg.name)
      else if (msg.op === 'append') await storage.append(msg.name, msg.data)
      else if (msg.op === 'appendIfSize')
        data = await storage.appendIfSize(msg.name, msg.data, msg.size)
      else if (msg.op === 'write') await storage.write(msg.name, msg.data)
      else await storage.remove(msg.name)
      scope.postMessage(
        { id: msg.id, ok: true, data } satisfies Response,
        data instanceof Uint8Array ? [data.buffer] : [],
      )
    } catch (e) {
      const name = e instanceof Error || e instanceof DOMException ? e.name : undefined
      const error = name ? (e as Error).message : String(e)
      scope.postMessage({ id: msg.id, ok: false, error, name } satisfies Response)
    }
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  serve(self as DedicatedWorkerGlobalScope)
}
