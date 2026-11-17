/**
 * The document as the transport uses it. `Y.Doc` from `yjs` (v13) and from
 * `@y/y` (v14) both fit, so the core never imports either.
 */
export interface TransportDoc {
  readonly clientID: number
  on(event: 'updateV2', f: (update: Uint8Array, origin: any) => void): void
  on(event: 'destroy', f: () => void): void
  off(event: 'updateV2', f: (update: Uint8Array, origin: any) => void): void
  off(event: 'destroy', f: () => void): void
  transact(f: () => void, origin?: unknown): unknown
  destroy(): void
}

/** What changed in an awareness `update` event. */
export interface AwarenessChanges {
  added: number[]
  updated: number[]
  removed: number[]
}

/** The `Awareness` of `y-protocols` (v13) or `@y/protocols` (v14), as the transport uses it. */
export interface TransportAwareness {
  on(event: 'update', f: (changes: AwarenessChanges, origin: any) => void): void
  off(event: 'update', f: (changes: AwarenessChanges, origin: any) => void): void
  getLocalState(): Record<string, any> | null
  setLocalState(state: Record<string, any> | null): void
  getStates(): Map<number, Record<string, any>>
  readonly meta: Map<number, unknown>
  destroy(): void
}

/** The Yjs and awareness functions the transport needs, passed in by the entry for one Yjs major. */
export interface TransportYjs<D extends TransportDoc, A extends TransportAwareness> {
  createDoc(): D
  encodeStateVector(doc: D): Uint8Array
  encodeStateAsUpdateV2(doc: D, stateVector?: Uint8Array): Uint8Array
  applyUpdateV2(doc: D, update: Uint8Array, origin?: unknown): void
  createAwareness(doc: D): A
  encodeAwarenessUpdate(awareness: A, clients: number[]): Uint8Array
  applyAwarenessUpdate(awareness: A, update: Uint8Array, origin: unknown): void
  removeAwarenessStates(awareness: A, clients: number[], origin: unknown): void
}

/** The part of `TransportYjs` the sync messages need. */
export type SyncYjs<D extends TransportDoc> = Pick<
  TransportYjs<D, never>,
  'encodeStateVector' | 'encodeStateAsUpdateV2' | 'applyUpdateV2'
>
