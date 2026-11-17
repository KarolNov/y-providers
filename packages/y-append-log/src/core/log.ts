/**
 * On-disk record format. A log file is a sequence of records:
 *
 *   [u32 length][u32 crc32][u8 type][payload...]
 *
 * `length` covers type + payload; `crc32` covers the same bytes. A torn or
 * corrupt record ends the readable prefix of the file; everything before it is
 * still valid, so a crash mid-append loses at most the unflushed tail.
 */

export const RECORD_UPDATE = 0
export const RECORD_SNAPSHOT = 1

const HEADER = 8

export interface LogRecord {
  type: number
  payload: Uint8Array
}

export interface ParsedLog {
  records: LogRecord[]
  /** Byte length of the valid prefix. Smaller than the input if the tail is torn. */
  validLength: number
}

let crcTable: Uint32Array | undefined
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function encodeRecord(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + 1 + payload.length)
  out[HEADER] = type
  out.set(payload, HEADER + 1)
  const view = new DataView(out.buffer)
  view.setUint32(0, 1 + payload.length, true)
  view.setUint32(4, crc32(out.subarray(HEADER)), true)
  return out
}

export function parseLog(bytes: Uint8Array): ParsedLog {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const records: LogRecord[] = []
  let offset = 0
  while (offset + HEADER <= bytes.length) {
    const length = view.getUint32(offset, true)
    const end = offset + HEADER + length
    if (length < 1 || end > bytes.length) break
    const body = bytes.subarray(offset + HEADER, end)
    if (crc32(body) !== view.getUint32(offset + 4, true)) break
    records.push({ type: body[0]!, payload: body.subarray(1) })
    offset = end
  }
  return { records, validLength: offset }
}

/** Snapshot payload: [u32 generation][Yjs update]. */
export function encodeSnapshot(generation: number, update: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + update.length)
  new DataView(out.buffer).setUint32(0, generation, true)
  out.set(update, 4)
  return encodeRecord(RECORD_SNAPSHOT, out)
}

export function decodeSnapshot(payload: Uint8Array): { generation: number; update: Uint8Array } {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return { generation: view.getUint32(0, true), update: payload.subarray(4) }
}
