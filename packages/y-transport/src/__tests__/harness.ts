import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { WebTransport } from '@fails-components/webtransport'
import { attachWebSocketServer } from '../server/ws.js'
import { serveWebTransport } from '../server/webtransport.js'
import type { SyncServer, SyncServerOptions } from '../core/server/index.js'
import type { TransportOptions } from '../core/transport.js'
import type { WebTransportSessionLike } from '../core/link.js'

export async function waitFor(condition: () => boolean, what = 'condition', ms = 8000) {
  const end = Date.now() + ms
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A self-signed certificate the way browsers accept it for WebTransport: ECDSA P-256, at most 14 days, pinned by hash. */
export function selfSignedCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'y-transport-cert-'))
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'k.pem'),
      '-out',
      join(dir, 'c.pem'),
      '-days',
      '13',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  )
  const cert = readFileSync(join(dir, 'c.pem'), 'utf8')
  const privKey = readFileSync(join(dir, 'k.pem'), 'utf8')
  const hash = createHash('sha256').update(new X509Certificate(cert).raw).digest()
  return { cert, privKey, hash }
}

// Version-free: the caller passes the `SyncServer` of its Yjs major (see helpers.ts).

export interface TestServer {
  server: SyncServer<any, any>
  wsUrl: string
  /** The client options for a WebTransport endpoint, plus the constructor for Node. */
  wtOptions: Pick<TransportOptions, 'webTransportUrl' | 'webTransportOptions' | 'WebTransport'>
  stop(): Promise<void>
}

/** Constructs a `SyncServer` of one Yjs major, as `y-transport/server` and `/server/y14` export it. */
export type ServerClass = new (options?: SyncServerOptions) => SyncServer<any, any>

export async function startServerWith(
  Server: ServerClass,
  options: SyncServerOptions = {},
  { webtransport = true } = {},
): Promise<TestServer> {
  const server = new Server(options)
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const stopHeartbeat = attachWebSocketServer(server, wss)
  const wsUrl = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`
  let endpoint: Awaited<ReturnType<typeof serveWebTransport>> | undefined
  let wtOptions: TestServer['wtOptions'] = {}
  if (webtransport) {
    const { cert, privKey, hash } = selfSignedCertificate()
    endpoint = await serveWebTransport(server, { port: 0, host: '127.0.0.1', cert, privKey })
    wtOptions = {
      webTransportUrl: `https://127.0.0.1:${endpoint.port}/sync`,
      webTransportOptions: { serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }] },
      WebTransport: WebTransport as unknown as new (
        url: string,
        options?: unknown,
      ) => WebTransportSessionLike,
    }
  }
  return {
    server,
    wsUrl,
    wtOptions,
    async stop() {
      stopHeartbeat()
      await server.close()
      await endpoint?.close()
      await new Promise<void>((r) => wss.close(() => r()))
    },
  }
}
