import * as Y from '@y/y'

/** Test helpers for Yjs v14; `y/v13.ts` has the same exports for v13. */
export const major = 14

const docWith = (key: string, value: string) => {
  const doc = new Y.Doc()
  doc.get('m').setAttr(key, value)
  return doc
}

/** A v2 update setting `key` to `value` in map `m`. */
export const update = (key: string, value: string) => Y.encodeStateAsUpdateV2(docWith(key, value))
/** The same, in the v1 encoding. */
export const v1Update = (key: string, value: string) => Y.encodeStateAsUpdate(docWith(key, value))
/** The v2 state of an empty document. */
export const emptyUpdate = () => Y.encodeStateAsUpdateV2(new Y.Doc())
/** v14 types its input as `Uint8Array<ArrayBuffer>`; the bytes are the same. */
export const mergeUpdatesV2 = (updates: Uint8Array[]) =>
  Y.mergeUpdatesV2(updates as Uint8Array<ArrayBuffer>[])

/** The map entries of what `load` resolved, applied in one transaction. */
export const entries = (updates: Uint8Array[] | null) => {
  const doc = new Y.Doc()
  doc.transact(() => {
    for (const u of updates!) Y.applyUpdateV2(doc, u)
  })
  return doc.get('m').getAttrs()
}
