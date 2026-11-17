import * as Y from 'yjs'

/** Test helpers for Yjs v13. `y/v13.ts` and `y/v14.ts` have the same exports. */
export const major = 13
export const Doc = Y.Doc
export type Doc = Y.Doc

/** Shared text `n`: `insert`, `toString`, `length`. */
export const text = (d: Y.Doc, n: string) => d.getText(n)
/** Shared array `n`: `push`, `toArray`, `length`. */
export const array = (d: Y.Doc, n: string) => d.getArray<any>(n)
/** Shared map `n`: `get`, `set`, `has`. */
export const map = (d: Y.Doc, n: string) => d.getMap<any>(n)
