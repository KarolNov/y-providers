// Where the sync server listens. server.ts binds these and the page reads
// CONFIG_URL, so the two cannot drift apart.
export const HOST = '127.0.0.1'
export const WS_PORT = 1234
export const WT_PORT = 4433
export const CONFIG_URL = `http://${HOST}:${WS_PORT}/config`
