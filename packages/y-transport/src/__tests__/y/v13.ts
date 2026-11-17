import * as Y from 'yjs'

/** Test helpers for Yjs v13. `y/v13.ts` and `y/v14.ts` have the same exports. */
export const major = 13
export const Doc = Y.Doc
export type Doc = Y.Doc
export const applyUpdateV2 = Y.applyUpdateV2
export const mergeUpdatesV2 = Y.mergeUpdatesV2

/** Shared text `n`: `insert`, `toString`, `length`. */
export const text = (d: Y.Doc, n: string) => d.getText(n)
