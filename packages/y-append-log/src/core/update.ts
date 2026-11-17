import type { UpdateCodec } from './yjs.js'

/**
 * Throws unless `update` is a whole Yjs v2 update, so a bad append cannot
 * poison every later load. Decoding it in full also rejects an update cut
 * short and a v1 update, which reading only its state vector lets through.
 */
export function assertUpdate(yjs: UpdateCodec, update: Uint8Array) {
  yjs.decodeUpdateV2(update)
}
