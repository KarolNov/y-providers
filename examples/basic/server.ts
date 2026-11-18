// The sync server: one SyncServer, reachable over WebSocket (TCP 1234) and
// WebTransport (UDP 4433). `node server.ts` serves Yjs v13 clients,
// `node server.ts --y14` serves Yjs v14 clients.
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { attachWebSocketServer } from 'y-transport/server/ws'
import { serveWebTransport } from 'y-transport/server/webtransport'
import { HOST, WS_PORT, WT_PORT } from './endpoints.ts'

export const y14 = process.argv.includes('--y14')

// Each entry loads only its own Yjs major, so pick one at startup.
const { SyncServer } = y14
  ? await import('y-transport/server/y14')
  : await import('y-transport/server')

// No `storage`: the server keeps documents in memory, and each browser keeps
// its own copy in OPFS, so a restarted server gets the document back from the
// first client that reconnects.
const server = new SyncServer()

/**
 * A self-signed certificate the way browsers accept it for WebTransport:
 * ECDSA P-256, valid for at most 14 days, pinned by the client by its SHA-256.
 * A new one per start; a real deployment uses a CA-signed certificate.
 */
function selfSignedCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'y-providers-example-'))
  try {
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
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '13',
        '-subj',
        `/CN=${HOST}`,
        '-addext',
        `subjectAltName=IP:${HOST}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    const cert = readFileSync(join(dir, 'cert.pem'), 'utf8')
    const privKey = readFileSync(join(dir, 'key.pem'), 'utf8')
    const hash = createHash('sha256').update(new X509Certificate(cert).raw).digest()
    return { cert, privKey, hash }
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim()
    throw new Error(
      `Could not make the self-signed certificate; this needs OpenSSL 1.1.1 or later as \`openssl\` on the path.${stderr ? `\nopenssl said: ${stderr}` : ''}`,
      { cause: error },
    )
  } finally {
    // The key is in memory now; do not leave it in the temp directory.
    rmSync(dir, { recursive: true, force: true })
  }
}
const { cert, privKey, hash } = selfSignedCertificate()

// The page fetches GET /config for the endpoints and the certificate hash to pin.
const config = {
  yjs: y14 ? 14 : 13,
  websocketUrl: `ws://${HOST}:${WS_PORT}`,
  webTransportUrl: `https://${HOST}:${WT_PORT}/sync`,
  certHash: [...hash],
}
/**
 * Only pages served from this machine (the Vite dev server) may use the server.
 * Any other site could otherwise read and write the documents: WebSocket has no
 * CORS, and /config would hand it the certificate hash WebTransport needs.
 */
function localOrigin(origin: string | undefined) {
  if (!origin) return false
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}
const http = createServer((req, res) => {
  if (localOrigin(req.headers.origin))
    res.setHeader('access-control-allow-origin', req.headers.origin!)
  if (req.url === '/config') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(config))
  } else {
    res.statusCode = 404
    res.end()
  }
})
attachWebSocketServer(
  server,
  new WebSocketServer({
    server: http,
    verifyClient: (info: { origin: string }) => localOrigin(info.origin),
  }),
)
await new Promise<void>((resolve) => http.listen(WS_PORT, HOST, resolve))
await serveWebTransport(server, { port: WT_PORT, host: HOST, cert, privKey })

console.log(`Sync server (Yjs v${config.yjs})`)
console.log(`  WebSocket     ${config.websocketUrl}`)
console.log(`  WebTransport  ${config.webTransportUrl}`)
