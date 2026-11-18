import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

/** Message types inside a frame. */
export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
/** The client stopped syncing this document; the connection stays up for others. Empty payload. */
export const MSG_LEAVE = 2
/** Liveness probe from the client, sent with an empty document name; the server answers with a pong. Empty payload. */
export const MSG_PING = 3
export const MSG_PONG = 4

/**
 * One frame is `varString(doc) varUint(type) payload`. A single connection
 * carries many documents, each frame names the one it belongs to.
 */
export function encodeFrame(doc: string, type: number, payload: Uint8Array): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarString(e, doc)
  encoding.writeVarUint(e, type)
  encoding.writeUint8Array(e, payload)
  return encoding.toUint8Array(e)
}

export interface Frame {
  doc: string
  type: number
  payload: Uint8Array
}

/** Returns null for anything malformed; a bad peer must not take the server down. */
export function decodeFrame(data: Uint8Array): Frame | null {
  try {
    const d = decoding.createDecoder(data)
    const doc = decoding.readVarString(d)
    const type = decoding.readVarUint(d)
    return { doc, type, payload: decoding.readTailAsUint8Array(d) }
  } catch {
    return null
  }
}

// ---- Handshake ---------------------------------------------------------------

/**
 * Frame formats this build speaks. A change to the frame layout or the meaning
 * of a message type gets a new version; a build that can still speak older
 * ones keeps them inside the range.
 */
export const PROTOCOL_VERSION = 2
/** 2 carries Yjs updates in the v2 encoding; 1 carried v1 and is no longer spoken. */
export const MIN_PROTOCOL_VERSION = 2

/**
 * The first message on every connection, in both directions:
 * `0xff varString('y-transport') varUint(min) varUint(max)`. This layout is frozen
 * so that any two versions can read each other's hello, whatever the frames
 * that follow look like.
 *
 * The leading 0xff makes a server from before the handshake drop the hello
 * without acting on it: read as a frame, it names a document of over 1024
 * characters that the message does not hold, so `decodeFrame` fails (or the
 * name is too long) before that server authorizes or opens anything. The
 * client then hears nothing and reports that as no handshake.
 */
const HELLO_MARK = 0xff
const HELLO_MAGIC = 'y-transport'

export interface VersionRange {
  min: number
  max: number
}

export const LOCAL_VERSIONS: VersionRange = { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION }

export function encodeHello(range: VersionRange = LOCAL_VERSIONS): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeUint8(e, HELLO_MARK)
  encoding.writeVarString(e, HELLO_MAGIC)
  encoding.writeVarUint(e, range.min)
  encoding.writeVarUint(e, range.max)
  return encoding.toUint8Array(e)
}

/** Null if `data` is not a hello, for example the first frame of a peer from before the handshake. Trailing bytes are left for later versions. */
export function decodeHello(data: Uint8Array): VersionRange | null {
  try {
    const d = decoding.createDecoder(data)
    if (decoding.readUint8(d) !== HELLO_MARK || decoding.readVarString(d) !== HELLO_MAGIC)
      return null
    const min = decoding.readVarUint(d)
    const max = decoding.readVarUint(d)
    // Versions start at 1.
    return min >= 1 && min <= max ? { min, max } : null
  } catch {
    return null
  }
}

/** The highest version both sides speak, or null if their ranges do not overlap. */
export function negotiateVersion(local: VersionRange, remote: VersionRange): number | null {
  const version = Math.min(local.max, remote.max)
  return version >= Math.max(local.min, remote.min) ? version : null
}

/**
 * The server does not speak a protocol version this client does. Reconnecting
 * will not help until one of them is upgraded, but the transport keeps trying
 * (with backoff) because a server can be redeployed under it.
 */
export class ProtocolVersionError extends Error {
  override readonly name = 'ProtocolVersionError'
  constructor(
    readonly local: VersionRange,
    /**
     * Null when the server sent no hello within `connectTimeout`, or answered with something else.
     * A server from before version negotiation stays silent; so does one that has stopped answering.
     */
    readonly remote: VersionRange | null,
  ) {
    super(
      remote
        ? `Incompatible sync protocol: this client speaks versions ${local.min}-${local.max}, the server ${remote.min}-${remote.max}`
        : `Incompatible sync protocol: the server sent no version handshake, so it is from before version negotiation or not answering (this client speaks versions ${local.min}-${local.max})`,
    )
  }
}
