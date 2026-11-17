import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'

/**
 * A UDP relay between one client and a server on 127.0.0.1, for tests that need to
 * interfere with a QUIC connection: `migrate()` makes the server see the client
 * from a new source port (what a NAT rebinding or a change of network looks
 * like) and `blackhole` silently drops everything while the sockets stay open.
 */
export async function udpProxy(targetPort: number) {
  let blackhole = false
  let clientAddress: { address: string; port: number } | null = null
  const front = createSocket('udp4')
  let upstream = createSocket('udp4')

  const bindUpstream = (socket: Socket) => {
    socket.on('message', (msg) => {
      if (!blackhole && clientAddress) front.send(msg, clientAddress.port, clientAddress.address)
    })
    socket.on('error', () => {})
  }
  bindUpstream(upstream)
  front.on('error', () => {})
  front.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
    clientAddress = rinfo
    if (!blackhole) upstream.send(msg, targetPort, '127.0.0.1')
  })
  await new Promise<void>((r) => front.bind(0, '127.0.0.1', r))
  await new Promise<void>((r) => upstream.bind(0, '127.0.0.1', r))

  return {
    port: front.address().port,
    /** The port the server currently sees the client on. */
    get upstreamPort() {
      return upstream.address().port
    },
    set blackhole(value: boolean) {
      blackhole = value
    },
    /** Switch to a fresh source port towards the server; the client notices nothing. */
    async migrate() {
      const old = upstream
      upstream = createSocket('udp4')
      bindUpstream(upstream)
      await new Promise<void>((r) => upstream.bind(0, '127.0.0.1', r))
      // The old path is gone for good, so the server can only keep talking to us by following the client.
      old.close()
    },
    close() {
      front.close()
      upstream.close()
    },
  }
}
