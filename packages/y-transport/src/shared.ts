// The client side of y-transport that does not touch Yjs; both client entries re-export it.
export {
  Transport,
  openTransport,
  webTransportSupported,
  type DocHandlers,
  type TransportEvent,
  type TransportMode,
  type TransportOptions,
  type TransportStatus,
} from './core/transport.js'
export {
  PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
  ProtocolVersionError,
  type VersionRange,
} from './core/protocol.js'
export type { SyncProviderOptions } from './core/provider.js'
export type { Link, WebSocketLike, WebTransportSessionLike } from './core/link.js'
