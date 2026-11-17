import { Http3Server } from '@fails-components/webtransport'
import { acceptWebTransportLink, type WebTransportSessionLike } from '../link.js'
import type { SyncServer } from './index.js'

export interface ServeWebTransportOptions {
  /** UDP port. 0 picks a free one. */
  port: number
  host?: string
  /** PEM certificate and private key. Browsers need a CA-signed one, or a self-signed one that is valid for at most 14 days and pinned by the client with `serverCertificateHashes`. */
  cert: string
  privKey: string
  /** URL path sessions connect to. Default `/sync`. */
  path?: string
  /** Secret for the QUIC connection. Default: random per start. */
  secret?: string
}

export interface WebTransportEndpoint {
  readonly port: number
  readonly host: string
  close(): Promise<void>
}

/**
 * Serve a `SyncServer` over WebTransport (HTTP/3, so UDP) using
 * `@fails-components/webtransport` and its prebuilt QUIC binary
 * (`@fails-components/webtransport-transport-http3-quiche`, install both).
 * The connection context passed to `authorize` is the session.
 */
export async function serveWebTransport(
  server: SyncServer<any, any>,
  options: ServeWebTransportOptions,
): Promise<WebTransportEndpoint> {
  const path = options.path ?? '/sync'
  const http3 = new Http3Server({
    port: options.port,
    host: options.host ?? '0.0.0.0',
    secret: options.secret ?? Math.random().toString(36).slice(2) + Date.now().toString(36),
    cert: options.cert,
    privKey: options.privKey,
    // The typings require defaultDatagramsReadableMode, but it is optional at runtime.
  } as ConstructorParameters<typeof Http3Server>[0])
  http3.startServer()
  await http3.ready
  const address = http3.address()!

  const sessions = (await http3.sessionStream(path)) as ReadableStream<WebTransportSessionLike>
  void (async () => {
    const reader = sessions.getReader()
    for (;;) {
      const { value: session, done } = await reader
        .read()
        .catch(() => ({ value: undefined, done: true }))
      if (done || !session) return
      acceptWebTransportLink(session).then(
        (link) => server.accept(link, session),
        () => {
          try {
            session.close()
          } catch {
            // already gone
          }
        },
      )
    }
  })()

  return {
    port: address.port,
    host: address.host,
    async close() {
      http3.stopServer()
    },
  }
}
