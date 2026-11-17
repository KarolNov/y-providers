import * as Y from '@y/y'

/** Test helpers for Yjs v14. `y/v13.ts` and `y/v14.ts` have the same exports. */
export const major = 14
export const Doc = Y.Doc
export type Doc = Y.Doc

/** Shared text `n`: `insert`, `toString`, `length`. */
export const text = (d: Y.Doc, n: string) => d.get(n)
/** Shared array `n`: `push`, `toArray`, `length`. */
export const array = (d: Y.Doc, n: string) => d.get(n)
/** Shared map `n`: `get`, `set`, `has`. Map entries are a v14 node's attributes. */
export const map = (d: Y.Doc, n: string) => {
  const node = d.get(n)
  return {
    get: (k: string) => node.getAttr(k),
    set: (k: string, v: unknown) => node.setAttr(k, v),
    has: (k: string) => node.hasAttr(k),
  }
}
