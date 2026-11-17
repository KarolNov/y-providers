import {
  openWebTransportLink,
  websocketLink,
  type Link,
  type WebSocketLike,
  type WebTransportSessionLike,
} from './link.js'
import {
  LOCAL_VERSIONS,
  MSG_PING,
  ProtocolVersionError,
  decodeFrame,
  decodeHello,
  encodeFrame,
  encodeHello,
  negotiateVersion,
} from './protocol.js'

export type TransportMode = 'auto' | 'webtransport' | 'websocket'

export type TransportStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'closed'

export type TransportEvent =
  | { type: 'connecting' }
  | { type: 'connected'; kind: Link['kind'] }
  | { type: 'disconnected' }
  /** `auto` gave up on WebTransport (`error`) and is using WebSocket instead. */
  | { type: 'fallback'; from: 'webtransport'; to: 'websocket'; error: unknown }
  /** A connection attempt failed. `error` is a `ProtocolVersionError` when the server speaks no protocol version this client does. */
  | { type: 'error'; kind: Link['kind']; error: unknown }

export interface TransportOptions {
  /**
   * - `'auto'` (default): WebTransport when the browser has it and `webTransportUrl` is given, else WebSocket.
   *   If a WebTransport connection cannot be made it falls back to WebSocket, and tries WebTransport again after `webTransportRetryAfter`.
   * - `'webtransport'`: WebTransport only; throws if it is unsupported or has no URL, and never falls back.
   * - `'websocket'`: WebSocket only.
   */
  mode?: TransportMode
  /** `ws://` or `wss://` endpoint. */
  websocketUrl?: string
  /** `https://` endpoint of the WebTransport server. */
  webTransportUrl?: string
  /** Passed to `new WebTransport(url, options)`, for example `serverCertificateHashes` for a self-signed certificate. */
  webTransportOptions?: Record<string, unknown>
  /** Supply the WebTransport constructor, for Node (`@fails-components/webtransport`) or tests. Defaults to the global. */
  WebTransport?: new (url: string, options?: any) => WebTransportSessionLike
  /** Supply the WebSocket constructor. Defaults to the global. */
  WebSocket?: new (url: string) => WebSocketLike
  /** Give up on one connection attempt after this many ms. Default 5000. */
  connectTimeout?: number
  /** In `auto`, how long to stay on WebSocket after WebTransport failed. Default 5 minutes. */
  webTransportRetryAfter?: number
  /** Reconnect delay grows from `minBackoff` to `maxBackoff` (ms), with jitter. Defaults 250 and 10000. */
  minBackoff?: number
  maxBackoff?: number
  /**
   * Liveness check. After this many ms without receiving anything the client pings the server; the
   * server's answer, or any other frame, counts as proof of life. Default 15000, 0 turns the check off.
   */
  pingInterval?: number
  /**
   * Close the connection, and so reconnect, after this many ms without receiving anything. Default
   * three times `pingInterval`, so two pings can be lost. Needs a server that answers pings.
   */
  idleTimeout?: number
}

/** What a provider registers for one document. */
export interface DocHandlers {
  /** The link is up (again): send your handshake. */
  open(link: Link): void
  frame(type: number, payload: Uint8Array): void
  /** The link is gone. */
  close(): void
}

/** Whether this runtime has WebTransport. */
export function webTransportSupported(): boolean {
  return typeof (globalThis as { WebTransport?: unknown }).WebTransport === 'function'
}

/**
 * One connection to a sync server, shared by every document that attaches to
 * it. Picks WebTransport or WebSocket, reconnects with backoff, and routes
 * frames to documents by name. Create it with `openTransport`.
 */
export class Transport {
  status: TransportStatus = 'idle'
  /** Which protocol the current connection uses, null while disconnected. */
  kind: Link['kind'] | null = null

  private readonly options: TransportOptions
  private readonly mode: TransportMode
  private readonly docs = new Map<string, DocHandlers>()
  private readonly listeners = new Set<(event: TransportEvent) => void>()
  private link: Link | null = null
  private started = false
  private closed = false
  private webTransportFailedAt = 0
  /** The protocol of the last connection attempt, for error events. */
  private attemptingKind: Link['kind'] = 'websocket'
  private wake: (() => void) | null = null
  private lastReceived = 0

  constructor(options: TransportOptions = {}) {
    this.options = options
    this.mode = options.mode ?? 'auto'
    if (this.mode !== 'auto' && this.mode !== 'webtransport' && this.mode !== 'websocket') {
      throw new Error(`Unknown transport mode: ${String(this.mode)}`)
    }
    if (this.mode === 'websocket' && !options.websocketUrl)
      throw new Error("mode 'websocket' needs a websocketUrl")
    if (this.mode === 'webtransport') {
      if (!options.webTransportUrl) throw new Error("mode 'webtransport' needs a webTransportUrl")
      if (!this.webTransportCtor()) throw new Error('WebTransport is not supported here')
    }
    if (
      this.mode === 'auto' &&
      !options.websocketUrl &&
      !(options.webTransportUrl && this.webTransportCtor())
    ) {
      throw new Error(
        'No usable endpoint: give a websocketUrl, or a webTransportUrl where WebTransport is supported',
      )
    }
  }

  /** Listen to connection events. Returns an unsubscribe function. */
  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Register a document. The connection starts with the first one. */
  attach(name: string, handlers: DocHandlers): () => void {
    if (this.closed) throw new Error('Transport is closed')
    if (this.docs.has(name))
      throw new Error(`Document "${name}" is already attached to this transport`)
    this.docs.set(name, handlers)
    if (this.link) handlers.open(this.link)
    if (!this.started) {
      this.started = true
      void this.run()
    }
    return () => {
      if (this.docs.get(name) === handlers) this.docs.delete(name)
    }
  }

  send(doc: string, type: number, payload: Uint8Array, options?: { unreliable?: boolean }): void {
    this.link?.send(encodeFrame(doc, type, payload), options)
  }

  /** Drops the connection and stops reconnecting. Attached documents keep working locally. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.status = 'closed'
    this.link?.close()
    this.wake?.()
  }

  private emit(event: TransportEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[y-transport]', error)
      }
    }
  }

  private webTransportCtor() {
    return (
      this.options.WebTransport ??
      (webTransportSupported() ? (globalThis as any).WebTransport : undefined)
    )
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms)
      const wake = done
      this.wake = wake
      function done() {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  private async run() {
    const min = this.options.minBackoff ?? 250
    const max = this.options.maxBackoff ?? 10_000
    let attempt = 0
    while (!this.closed) {
      this.status = 'connecting'
      this.emit({ type: 'connecting' })
      let link: Link | null = null
      try {
        link = await this.dial()
      } catch (error) {
        this.emit({ type: 'error', kind: this.attemptingKind, error })
      }
      if (this.closed) {
        link?.close()
        return
      }
      const connectedAt = Date.now()
      if (link) {
        this.link = link
        this.kind = link.kind
        this.status = 'connected'
        this.lastReceived = Date.now()
        link.onFrame = (data) => {
          this.lastReceived = Date.now()
          this.route(data)
        }
        const stopWatching = this.watch(link)
        this.emit({ type: 'connected', kind: link.kind })
        for (const handlers of this.docs.values()) handlers.open(link)
        await link.closed
        stopWatching()
        this.link = null
        this.kind = null
        this.status = 'disconnected'
        for (const handlers of this.docs.values()) handlers.close()
        this.emit({ type: 'disconnected' })
        if (this.closed) return
      }
      // A link that lived a while was healthy, so start the backoff over.
      attempt = link && Date.now() - connectedAt > 5000 ? 0 : attempt + 1
      const delay = Math.min(max, min * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2)
      await this.sleep(delay)
    }
  }

  /** Pings a quiet link and closes one that stays silent, so a dead connection is noticed without waiting for the OS. */
  private watch(link: Link): () => void {
    const interval = this.options.pingInterval ?? 15_000
    if (!interval) return () => {}
    const timeout = this.options.idleTimeout ?? interval * 3
    const timer = setInterval(
      () => {
        const idle = Date.now() - this.lastReceived
        if (idle >= timeout) link.close()
        else if (idle >= interval) link.send(encodeFrame('', MSG_PING, new Uint8Array(0)))
      },
      Math.max(10, Math.min(interval, timeout) / 2),
    )
    return () => clearInterval(timer)
  }

  private route(data: Uint8Array) {
    const frame = decodeFrame(data)
    if (frame) this.docs.get(frame.doc)?.frame(frame.type, frame.payload)
  }

  private order(): Link['kind'][] {
    const { websocketUrl, webTransportUrl, webTransportRetryAfter = 5 * 60_000 } = this.options
    if (this.mode === 'websocket') return ['websocket']
    if (this.mode === 'webtransport') return ['webtransport']
    const wtUsable = !!webTransportUrl && !!this.webTransportCtor()
    const recentlyFailed =
      this.webTransportFailedAt > 0 &&
      Date.now() - this.webTransportFailedAt < webTransportRetryAfter
    if (wtUsable && !(recentlyFailed && websocketUrl))
      return websocketUrl ? ['webtransport', 'websocket'] : ['webtransport']
    return ['websocket']
  }

  private async dial(): Promise<Link> {
    const order = this.order()
    let lastError: unknown
    for (const kind of order) {
      this.attemptingKind = kind
      try {
        const link =
          kind === 'webtransport' ? await this.dialWebTransport() : await this.dialWebSocket()
        try {
          await this.handshake(link)
        } catch (error) {
          link.close()
          throw error
        }
        return link
      } catch (error) {
        // The link to the server works; the other protocol reaches the same server, which would not answer differently.
        if (error instanceof ProtocolVersionError) throw error
        lastError = error
        if (kind === 'webtransport' && this.mode === 'auto') {
          this.webTransportFailedAt = Date.now()
          if (order.includes('websocket'))
            this.emit({ type: 'fallback', from: 'webtransport', to: 'websocket', error })
        } else if (order.length > 1) {
          this.emit({ type: 'error', kind, error })
        }
      }
    }
    throw lastError
  }

  private withTimeout<T>(promise: Promise<T>, what: string, onTimeout: () => void): Promise<T> {
    const ms = this.options.connectTimeout ?? 5000
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        onTimeout()
        reject(new Error(`${what} timed out after ${ms} ms`))
      }, ms)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  /**
   * Exchange hellos; resolves once the server's says it speaks a version this client does. Silence
   * for `connectTimeout` is a `ProtocolVersionError` too: a server from before the handshake drops
   * the hello and says nothing.
   */
  private handshake(link: Link): Promise<void> {
    const ms = this.options.connectTimeout ?? 5000
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProtocolVersionError(LOCAL_VERSIONS, null)), ms)
      link.onFrame = (data) => {
        clearTimeout(timer)
        link.onFrame = null
        const remote = decodeHello(data)
        if (remote && negotiateVersion(LOCAL_VERSIONS, remote) !== null) resolve()
        else reject(new ProtocolVersionError(LOCAL_VERSIONS, remote))
      }
      void link.closed.then(() => {
        clearTimeout(timer)
        reject(new Error('Connection closed during the protocol handshake'))
      })
      link.send(encodeHello())
    })
  }

  private async dialWebTransport(): Promise<Link> {
    const WT = this.webTransportCtor()!
    const session = new WT(this.options.webTransportUrl!, this.options.webTransportOptions)
    // A failed handshake rejects `closed` as well as `ready`; do not leave it unhandled.
    session.closed.catch(() => {})
    try {
      return await this.withTimeout(openWebTransportLink(session), 'WebTransport connect', () =>
        session.close(),
      )
    } catch (error) {
      try {
        session.close()
      } catch {
        // never opened
      }
      throw error
    }
  }

  private async dialWebSocket(): Promise<Link> {
    const WS = this.options.WebSocket ?? (globalThis as any).WebSocket
    if (!WS) throw new Error('WebSocket is not available here')
    const ws: WebSocketLike = new WS(this.options.websocketUrl!)
    const link = websocketLink(ws)
    const opened = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', resolve)
      void link.closed.then(() => reject(new Error('WebSocket connection failed')))
    })
    try {
      await this.withTimeout(opened, 'WebSocket connect', () => link.close())
      return link
    } catch (error) {
      link.close()
      throw error
    }
  }
}

/**
 * Creates the shared connection, by default WebTransport with a WebSocket
 * fallback.
 *
 *   openTransport({ webTransportUrl: 'https://sync.example.com/sync', websocketUrl: 'wss://sync.example.com/sync' })
 *   openTransport({ mode: 'websocket', websocketUrl: 'ws://localhost:1234' })
 */
export function openTransport(options: TransportOptions = {}): Transport {
  return new Transport(options)
}
