import * as encoding from 'lib0/encoding'

/**
 * A message pipe to one peer, the same shape for WebSocket and WebTransport on
 * both the client and the server. The sync logic only ever sees this.
 */
export interface Link {
  readonly kind: 'websocket' | 'webtransport'
  /** `unreliable` frames may be dropped (datagrams); they fall back to reliable when they do not fit. */
  send(frame: Uint8Array, options?: { unreliable?: boolean }): void
  /** Resolves once, when the link is gone for any reason. */
  readonly closed: Promise<void>
  close(): void
  onFrame: ((frame: Uint8Array) => void) | null
}

// ---- WebSocket -------------------------------------------------------------

/** The subset of the WebSocket API used, satisfied by the browser, Node's global and `ws`. */
export interface WebSocketLike {
  binaryType: string
  readyState: number
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
}

const WS_OPEN = 1

export function websocketLink(ws: WebSocketLike): Link {
  ws.binaryType = 'arraybuffer'
  let resolve!: () => void
  const closed = new Promise<void>((r) => (resolve = r))
  const link: Link = {
    kind: 'websocket',
    closed,
    onFrame: null,
    send(frame) {
      if (ws.readyState === WS_OPEN) ws.send(frame)
    },
    close() {
      try {
        ws.close()
      } catch {
        // already closed
      }
      // On a dead connection the close handshake may never finish, and the owner must not wait for it.
      resolve()
    },
  }
  ws.addEventListener('message', (event) => {
    const data = event.data
    // `ws` hands over Buffers unless binaryType says otherwise; browsers hand over ArrayBuffers.
    if (data instanceof ArrayBuffer) link.onFrame?.(new Uint8Array(data))
    else if (ArrayBuffer.isView(data))
      link.onFrame?.(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  })
  ws.addEventListener('close', resolve)
  ws.addEventListener('error', resolve)
  return link
}

// ---- WebTransport ----------------------------------------------------------

/** The subset of a WebTransport session used, satisfied by browsers and `@fails-components/webtransport` (client and server side). */
export interface WebTransportSessionLike {
  readonly ready: Promise<unknown>
  readonly closed: Promise<unknown>
  readonly datagrams: {
    readonly readable: ReadableStream<Uint8Array>
    readonly writable?: WritableStream<Uint8Array>
    createWritable?(): WritableStream<Uint8Array>
    readonly maxDatagramSize?: number
  }
  createBidirectionalStream(): Promise<{
    readable: ReadableStream<Uint8Array>
    writable: WritableStream<Uint8Array>
  }>
  readonly incomingBidirectionalStreams: ReadableStream<{
    readable: ReadableStream<Uint8Array>
    writable: WritableStream<Uint8Array>
  }>
  close(info?: { closeCode?: number; reason?: string }): void
}

/** Frames on the reliable stream are length-prefixed; a zero-length frame is a hello and is ignored. */
const MAX_FRAME = 64 * 1024 * 1024

function prefixed(frame: Uint8Array): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, frame.length)
  encoding.writeUint8Array(e, frame)
  return encoding.toUint8Array(e)
}

/**
 * Splits a byte stream into length-prefixed frames. Returns false if the stream
 * is corrupt. Chunks are only joined once a whole frame is there, so a large
 * frame arriving in many small chunks is copied once, not once per chunk.
 */
export function createFrameReader(
  onFrame: (frame: Uint8Array) => void,
): (chunk: Uint8Array) => boolean {
  let chunks: Uint8Array[] = []
  let size = 0
  const join = () => {
    if (chunks.length === 1) return chunks[0]!
    const all = new Uint8Array(size)
    let offset = 0
    for (const c of chunks) {
      all.set(c, offset)
      offset += c.length
    }
    chunks = [all]
    return all
  }
  return (chunk) => {
    if (chunk.length) {
      chunks.push(chunk)
      size += chunk.length
    }
    for (;;) {
      // Read the varuint length by hand so a partial prefix is not an error.
      let length = 0
      let shift = 0
      let header = 0
      let complete = false
      outer: for (const c of chunks) {
        for (let i = 0; i < c.length; i++) {
          const byte = c[i]!
          header++
          length += (byte & 0x7f) * 2 ** shift
          shift += 7
          if (!(byte & 0x80)) {
            complete = true
            break outer
          }
          if (shift > 35) return false
        }
      }
      if (!complete) return true
      if (length > MAX_FRAME) return false
      if (size < header + length) return true
      const all = join()
      const frame = all.slice(header, header + length)
      const rest = all.subarray(header + length)
      chunks = rest.length ? [rest] : []
      size = rest.length
      if (frame.length) onFrame(frame)
    }
  }
}

async function pump(
  readable: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => boolean | void,
) {
  const reader = readable.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      if (onChunk(value) === false) return
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Wraps an established session: reliable frames go over one bidirectional
 * stream, unreliable ones over datagrams. `stream` is the client-created
 * stream; on the server it is the first stream the peer opens.
 */
export function webTransportLink(
  session: WebTransportSessionLike,
  stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
): Link {
  const writer = stream.writable.getWriter()
  const datagramWriter = (
    session.datagrams.createWritable?.() ?? session.datagrams.writable
  )?.getWriter()
  let resolve!: () => void
  const closed = new Promise<void>((r) => (resolve = r))
  let done = false
  const finish = () => {
    if (done) return
    done = true
    try {
      session.close()
    } catch {
      // already closed
    }
    resolve()
  }
  // Writes must not interleave and must not reject into nowhere.
  let chain: Promise<unknown> = Promise.resolve()
  const link: Link = {
    kind: 'webtransport',
    closed,
    onFrame: null,
    send(frame, options) {
      if (done) return
      const max = session.datagrams.maxDatagramSize
      if (options?.unreliable && datagramWriter && (max === undefined || frame.length <= max)) {
        datagramWriter.write(frame).catch(() => {})
        return
      }
      const bytes = prefixed(frame)
      chain = chain.then(() => writer.write(bytes)).catch(finish)
    },
    close: finish,
  }
  const read = createFrameReader((frame) => link.onFrame?.(frame))
  pump(stream.readable, (chunk) => read(chunk)).then(finish, finish)
  pump(session.datagrams.readable, (chunk) => {
    if (chunk.length) link.onFrame?.(chunk)
  }).catch(() => {})
  session.closed.then(finish, finish)
  return link
}

/** Client side: open the stream and say hello so the peer sees it (QUIC streams are invisible until they carry data). */
export async function openWebTransportLink(session: WebTransportSessionLike): Promise<Link> {
  await session.ready
  const stream = await session.createBidirectionalStream()
  const writer = stream.writable.getWriter()
  await writer.write(prefixed(new Uint8Array(0)))
  writer.releaseLock()
  return webTransportLink(session, stream)
}

/** Server side: wait for the client's stream. */
export async function acceptWebTransportLink(session: WebTransportSessionLike): Promise<Link> {
  await session.ready
  const reader = session.incomingBidirectionalStreams.getReader()
  const { value, done } = await reader.read()
  reader.releaseLock()
  if (done || !value) throw new Error('session closed before opening a stream')
  return webTransportLink(session, value)
}
