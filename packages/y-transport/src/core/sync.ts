import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { SyncYjs, TransportDoc } from './yjs.js'

/**
 * The sync exchange of `y-protocols/sync` with every update in the v2 encoding:
 * the same three messages, `varUint(type) varUint8Array(body)`, where step 1
 * carries a state vector and step 2 and update carry a v2 update.
 */
export const SYNC_STEP1 = 0
export const SYNC_STEP2 = 1
export const SYNC_UPDATE = 2

/** Asks for what the other side has that `doc` lacks. */
export function writeSyncStep1<D extends TransportDoc>(
  encoder: encoding.Encoder,
  doc: D,
  yjs: SyncYjs<D>,
) {
  encoding.writeVarUint(encoder, SYNC_STEP1)
  encoding.writeVarUint8Array(encoder, yjs.encodeStateVector(doc))
}

export function writeUpdate(encoder: encoding.Encoder, update: Uint8Array) {
  encoding.writeVarUint(encoder, SYNC_UPDATE)
  encoding.writeVarUint8Array(encoder, update)
}

/**
 * Handles one sync message: answers a step 1 into `reply`, applies a step 2 or
 * an update to `doc` with `origin`. Returns the message type. Throws on a
 * malformed message or update; the caller decides what that costs the sender.
 */
export function readSyncMessage<D extends TransportDoc>(
  decoder: decoding.Decoder,
  reply: encoding.Encoder,
  doc: D,
  origin: unknown,
  yjs: SyncYjs<D>,
): number {
  const type = decoding.readVarUint(decoder)
  switch (type) {
    case SYNC_STEP1: {
      const stateVector = decoding.readVarUint8Array(decoder)
      encoding.writeVarUint(reply, SYNC_STEP2)
      encoding.writeVarUint8Array(reply, yjs.encodeStateAsUpdateV2(doc, stateVector))
      break
    }
    case SYNC_STEP2:
    case SYNC_UPDATE:
      yjs.applyUpdateV2(doc, decoding.readVarUint8Array(decoder), origin)
      break
    default:
      throw new Error(`Unknown sync message type ${type}`)
  }
  return type
}
