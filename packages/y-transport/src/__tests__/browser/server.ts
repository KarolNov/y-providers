// Runs in Node, in the Vitest main process: starts the sync server the browser
// tests talk to and lets them drop its connections through a browser command.
import type { BrowserCommand } from 'vitest/node'
import type { TestProject } from 'vitest/node'
import { startServerWith, type ServerClass, type TestServer } from '../harness.js'

export interface BrowserTestServer {
  wsUrl: string
  webTransportUrl: string
  /** SHA-256 of the self-signed certificate, as bytes (provide/inject only carries JSON). */
  certHash: number[]
}

declare module 'vitest' {
  interface ProvidedContext {
    transportServer: BrowserTestServer
  }
}

// Each browser instance is its own project with its own global setup and
// server. The global setup and the config's commands are loaded as separate
// module instances, so they meet through a global, keyed by project name.
const key = Symbol.for('y-transport/browser-test-servers')
const servers = ((globalThis as { [key]?: Map<string, TestServer> })[key] ??= new Map())

/** The server of the project's Yjs major. Loaded here, not imported, because the config imports this file. */
async function serverClass(project: TestProject): Promise<ServerClass> {
  return project.name.includes('v14')
    ? (await import('../../server/y14.js')).SyncServer
    : (await import('../../server/index.js')).SyncServer
}

export default async function setup(project: TestProject) {
  const s = await startServerWith(await serverClass(project))
  servers.set(project.name, s)
  const hash = s.wtOptions.webTransportOptions!.serverCertificateHashes as Array<{
    value: Uint8Array
  }>
  project.provide('transportServer', {
    wsUrl: s.wsUrl,
    webTransportUrl: s.wtOptions.webTransportUrl!,
    certHash: [...hash[0]!.value],
  })
  return async () => {
    servers.delete(project.name)
    await s.stop()
  }
}

/** Closes every connection on the server side, as a crash or a deploy would. */
export const dropConnections: BrowserCommand<[]> = ({ project }) => {
  // Global setup may run once for the whole project or once per browser instance.
  const s = servers.get(project.name) ?? servers.get(project.name.replace(/ \([^)]*\)$/, ''))
  if (!s)
    throw new Error(
      `no transport test server for project ${project.name}; have ${[...servers.keys()].join(', ')}`,
    )
  const links = (s.server as unknown as { links: Set<{ close(): void }> }).links
  const count = links.size
  for (const link of links) link.close()
  return count
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    dropConnections(): Promise<number>
  }
}
