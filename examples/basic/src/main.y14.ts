// Yjs v14. src/main.ts is the same page on Yjs v13; they differ only in
// the imports, the major they name and `doc.getArray` (v13) against `doc.get` (v14).
import * as Y from '@y/y'
import { OpfsPersistence, openStorage } from 'y-opfs/y14'
import { SyncProvider, openTransport } from 'y-transport/y14'
import { start } from './ui.ts'

const doc = new Y.Doc()
void start({
  major: 14,
  openStorage,
  persist: (name, storage) => new OpfsPersistence(name, doc, storage),
  list: () => doc.get('items'),
  sync: (name, options) => {
    const transport = openTransport(options)
    new SyncProvider(name, doc, transport)
    return transport
  },
})
