// Yjs v13. src/main.y14.ts is the same page on Yjs v14; they differ only in
// the imports, the major they name and `doc.getArray` (v13) against `doc.get` (v14).
import * as Y from 'yjs'
import { OpfsPersistence, openStorage } from 'y-opfs'
import { SyncProvider, openTransport } from 'y-transport'
import { start } from './ui.ts'

const doc = new Y.Doc()
void start({
  major: 13,
  openStorage,
  persist: (name, storage) => new OpfsPersistence(name, doc, storage),
  list: () => doc.getArray<string>('items'),
  sync: (name, options) => {
    const transport = openTransport(options)
    new SyncProvider(name, doc, transport)
    return transport
  },
})
