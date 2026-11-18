// `pnpm dev`: the sync server and the Vite dev server in one process.
// `pnpm dev:y14` does the same for Yjs v14.
import { createServer } from 'vite'
import { y14 } from './server.ts'

const vite = await createServer({ mode: y14 ? 'y14' : 'development' })
await vite.listen()
vite.printUrls()
