import { SyncServer } from '#server'
import type { SyncServerOptions } from '../core/server/index.js'
import { startServerWith } from './harness.js'

export { selfSignedCertificate, waitFor, type TestServer } from './harness.js'

/** A sync server of the Yjs major under test on WebSocket and, unless turned off, WebTransport. */
export const startServer = (
  options: SyncServerOptions = {},
  opts: { webtransport?: boolean } = {},
) => startServerWith(SyncServer, options, opts)
