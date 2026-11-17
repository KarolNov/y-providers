import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import type { TransportYjs } from './core/yjs.js'

/** Yjs v13 and its awareness protocol, for the core. */
export const yjs: TransportYjs<Y.Doc, awarenessProtocol.Awareness> = {
  createDoc: () => new Y.Doc(),
  encodeStateVector: (doc) => Y.encodeStateVector(doc),
  encodeStateAsUpdateV2: (doc, stateVector) => Y.encodeStateAsUpdateV2(doc, stateVector),
  applyUpdateV2: (doc, update, origin) => Y.applyUpdateV2(doc, update, origin),
  createAwareness: (doc) => new awarenessProtocol.Awareness(doc),
  encodeAwarenessUpdate: awarenessProtocol.encodeAwarenessUpdate,
  applyAwarenessUpdate: awarenessProtocol.applyAwarenessUpdate,
  removeAwarenessStates: awarenessProtocol.removeAwarenessStates,
}
