// The page around the document. Holds no Yjs, so main.ts (v13) and
// main.y14.ts (v14) share it.
import type { StorageBackend } from 'y-opfs'
import type { Transport, TransportOptions } from 'y-transport'

/** What the server hands out at GET /config (see server.ts). */
interface ServerConfig {
  yjs: number
  websocketUrl: string
  webTransportUrl: string
  certHash: number[]
}

/** Transport options for the example server: WebTransport with WebSocket fallback, pinning its self-signed certificate. */
export async function serverOptions(major: number): Promise<TransportOptions> {
  const config: ServerConfig = await fetch('http://127.0.0.1:1234/config').then(
    (r) => r.json(),
    () => {
      throw new Error('the sync server is not running; showing the local copy only.')
    },
  )
  if (config.yjs !== major)
    throw new Error(
      `The server runs Yjs v${config.yjs} and this page v${major}; start both with the same major.`,
    )
  return {
    websocketUrl: config.websocketUrl,
    webTransportUrl: config.webTransportUrl,
    // A self-signed certificate is accepted only when pinned by its hash, as bytes.
    webTransportOptions: {
      serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(config.certHash) }],
    },
  }
}

/** The calls the page needs from a shared array; Yjs v13 and v14 both have them. */
interface SharedList {
  toArray(): unknown[]
  push(items: string[]): void
  observe(f: () => void): unknown
}

/** Renders `list` into the page and appends what the form submits. */
export function bindList(list: SharedList) {
  const ul = document.querySelector<HTMLUListElement>('#items')!
  const input = document.querySelector<HTMLInputElement>('#item')!
  const render = () => {
    ul.replaceChildren(
      ...list.toArray().map((item) => {
        const li = document.createElement('li')
        li.textContent = String(item)
        return li
      }),
    )
  }
  list.observe(render)
  render()
  document.querySelector('#add')!.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (text) list.push([text])
    input.value = ''
  })
}

const STORAGE_NAMES: Record<StorageBackend, string> = {
  opfs: 'OPFS',
  indexeddb: 'IndexedDB',
  memory: 'memory',
}
const TRANSPORT_NAMES = { webtransport: 'WebTransport', websocket: 'WebSocket' }

/** Keeps the status line current: Yjs major, storage backend, transport and its state. */
export function showStatus(major: number, storage: StorageBackend, transport: Transport) {
  const line = document.querySelector('#status')!
  const render = () => {
    const kind = transport.kind ? TRANSPORT_NAMES[transport.kind] : '–'
    line.textContent = `Yjs v${major} · storage: ${STORAGE_NAMES[storage]} · transport: ${kind} (${transport.status})`
  }
  transport.subscribe(render)
  render()
}

export function showError(error: unknown) {
  document.querySelector('#status')!.textContent =
    `Error: ${error instanceof Error ? error.message : String(error)}`
  console.error(error)
}
