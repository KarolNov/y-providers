import * as Y from 'yjs'
import type { AppendLogYjs } from './core/yjs.js'

/** Yjs v13 (`yjs`) for the core. */
export const yjs: AppendLogYjs = {
  decodeUpdateV2: Y.decodeUpdateV2,
  mergeUpdatesV2: Y.mergeUpdatesV2,
  entryUpdate(clientID, key, value) {
    const doc = new Y.Doc()
    doc.clientID = clientID
    doc.getMap('m').set(key, value)
    return Y.encodeStateAsUpdateV2(doc)
  },
  entries(updates) {
    const doc = new Y.Doc()
    doc.transact(() => {
      for (const update of updates) Y.applyUpdateV2(doc, update)
    })
    return doc.getMap('m').toJSON()
  },
}
