import * as Y from '@y/y'
import type { AppendLogYjs } from './core/yjs.js'

/** Yjs v14 (`@y/y`) for the core. */
export const yjs: AppendLogYjs = {
  decodeUpdateV2: Y.decodeUpdateV2,
  mergeUpdatesV2: Y.mergeUpdatesV2,
  entryUpdate(clientID, key, value) {
    const doc = new Y.Doc()
    doc.clientID = clientID
    doc.get('m').setAttr(key, value)
    return Y.encodeStateAsUpdateV2(doc)
  },
  entries(updates) {
    const doc = new Y.Doc()
    doc.transact(() => {
      for (const update of updates) Y.applyUpdateV2(doc, update)
    })
    return doc.get('m').getAttrs()
  },
}
