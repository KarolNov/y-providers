import type { IncomingMessage } from 'node:http'
import type { WebSocket, WebSocketServer } from 'ws'
import { websocketLink, type WebSocketLike } from '../link.js'
import type { SyncServer } from './index.js'

export interface AttachWebSocketOptions {
  /** Ping every connection this often (ms) and drop those that do not answer. Default 30000, 0 turns it off. */
  heartbeat?: number
}

/**
 * Serve a `SyncServer` over a `ws` WebSocketServer. The connection context
 * passed to `authorize` is the `IncomingMessage`.
 *
 *   const wss = new WebSocketServer({ port: 1234 })
 *   attachWebSocketServer(new SyncServer(), wss)
 *
 * Returns a function that stops the heartbeat.
 */
export function attachWebSocketServer(
  server: SyncServer<any, any>,
  wss: WebSocketServer,
  options: AttachWebSocketOptions = {},
): () => void {
  const alive = new WeakMap<WebSocket, boolean>()
  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    alive.set(ws, true)
    ws.on('pong', () => alive.set(ws, true))
    server.accept(websocketLink(ws as unknown as WebSocketLike), request)
  })
  const interval = options.heartbeat ?? 30_000
  if (!interval) return () => {}
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate()
        continue
      }
      alive.set(ws, false)
      ws.ping()
    }
  }, interval)
  timer.unref()
  wss.on('close', () => clearInterval(timer))
  return () => clearInterval(timer)
}
