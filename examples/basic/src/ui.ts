// The page around the document. Holds no Yjs, so main.ts (v13) and
// main.y14.ts (v14) share it: they hand in their major's calls.
import type { OpenedStorage, StorageBackend, openStorage } from 'y-opfs'
import type { Transport, TransportOptions } from 'y-transport'
import { CONFIG_URL } from '../endpoints.ts'

/** What main.ts and main.y14.ts hand to `start`, each from its own Yjs major. */
export interface Page {
  major: number
  openStorage: typeof openStorage
  /** Restore the document from `storage` and keep saving it there. */
  persist(name: string, storage: OpenedStorage['storage']): { whenSynced: Promise<unknown> }
  /** The shared list in the document. */
  list(): SharedList
  /** Connect the document to the server; returns the transport, for the status line. */
  sync(name: string, options: TransportOptions): Transport
}

/** Local copy first, then the server copy once the server answers. */
export async function start(page: Page) {
  // One name per major: both pages share an origin, so they would share the stored log.
  const name = `example-v${page.major}`
  try {
    // Local copy: OPFS through a worker, or IndexedDB where OPFS is unavailable.
    const { storage, active } = await page.openStorage({
      createWorker: () => new Worker(new URL('y-opfs/worker', import.meta.url), { type: 'module' }),
    })
    await page.persist(name, storage).whenSynced
    // The list works from the local copy alone, with or without the server.
    bindList(page.list())

    // Server copy: WebTransport, or WebSocket where WebTransport is unavailable.
    setStatus(page.major, active, `waiting for the sync server at ${CONFIG_URL}`)
    const transport = page.sync(name, await serverOptions(page.major))
    showStatus(page.major, active, transport)
  } catch (error) {
    showError(error)
  }
}

/** What the server hands out at GET /config (see server.ts). */
interface ServerConfig {
  yjs: number
  websocketUrl: string
  webTransportUrl: string
  certHash: number[]
}

/** The server's config, asking again every few seconds until the sync server answers. */
async function fetchConfig(): Promise<ServerConfig> {
  for (;;) {
    try {
      const response = await fetch(CONFIG_URL)
      // Something else on the port answers with an error or with no JSON: keep waiting for the sync server.
      if (response.ok) return (await response.json()) as ServerConfig
    } catch {
      // not running yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

/** Transport options for the example server: WebTransport with WebSocket fallback, pinning its self-signed certificate. */
async function serverOptions(major: number): Promise<TransportOptions> {
  const config = await fetchConfig()
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
function bindList(list: SharedList) {
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

function setStatus(major: number, storage: StorageBackend, transport: string) {
  document.querySelector('#status')!.textContent =
    `Yjs v${major} · storage: ${STORAGE_NAMES[storage]} · transport: ${transport}`
}

/** Keeps the status line current: Yjs major, storage backend, transport and its state. */
function showStatus(major: number, storage: StorageBackend, transport: Transport) {
  const render = () => {
    const kind = transport.kind ? TRANSPORT_NAMES[transport.kind] : '–'
    setStatus(major, storage, `${kind} (${transport.status})`)
  }
  transport.subscribe(render)
  render()
}

function showError(error: unknown) {
  document.querySelector('#status')!.textContent =
    `Error: ${error instanceof Error ? error.message : String(error)}`
  console.error(error)
}
