// Yjs v14. src/main.ts is the same page on Yjs v13; they differ only in
// the imports, the major they name and `doc.getArray` (v13) against `doc.get` (v14).
import * as Y from '@y/y'
import { OpfsPersistence, openStorage } from 'y-opfs/y14'
import { SyncProvider, openTransport } from 'y-transport/y14'
import { bindList, serverOptions, showError, showStatus } from './ui.ts'

// One name per major: both pages share an origin, so they would share the stored log.
const DOC = 'example-v14'

try {
  const doc = new Y.Doc()

  // Local copy: OPFS through a worker, or IndexedDB where OPFS is unavailable.
  const { storage, active } = await openStorage({
    createWorker: () => new Worker(new URL('y-opfs/worker', import.meta.url), { type: 'module' }),
  })
  const persistence = new OpfsPersistence(DOC, doc, storage)
  await persistence.whenSynced
  // The list works from the local copy alone, with or without the server.
  bindList(doc.get('items'))

  // Server copy: WebTransport, or WebSocket where WebTransport is unavailable.
  const transport = openTransport(await serverOptions(14))
  new SyncProvider(DOC, doc, transport)

  showStatus(14, active, transport)
} catch (error) {
  showError(error)
}
