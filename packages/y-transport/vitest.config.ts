import { fileURLToPath } from 'node:url'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import { dropConnections } from './src/__tests__/browser/server.js'

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url))

type Major = 'v13' | 'v14'

/** `#entry`/`#server` are the entries under test, `#y` their test helpers, `#log` y-append-log, all of one major. */
const alias = (major: Major) => ({
  '#entry': src(major === 'v13' ? 'index.ts' : 'y14.ts'),
  '#server': src(major === 'v13' ? 'server/index.ts' : 'server/y14.ts'),
  '#y': src(`__tests__/y/${major}.ts`),
  '#log': major === 'v13' ? 'y-append-log' : 'y-append-log/y14',
})

const node = (major: Major) => ({
  extends: true,
  resolve: { alias: alias(major) },
  test: {
    name: `node-${major}`,
    environment: 'node' as const,
    include: ['src/**/__tests__/*.test.ts'],
    exclude: [
      'src/**/__tests__/**/*.browser.test.ts',
      // Imports both majors directly, so one project is enough.
      ...(major === 'v14' ? ['src/**/__tests__/mixed-majors.test.ts'] : []),
    ],
  },
})

const browser = (major: Major) => ({
  extends: true,
  resolve: { alias: alias(major) },
  test: {
    name: `browser-${major}`,
    include: ['src/**/__tests__/**/*.browser.test.ts'],
    // The sync server runs in Node; the tests reach it over the network.
    globalSetup: ['src/__tests__/browser/server.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [
        { browser: 'chromium' as const },
        { browser: 'firefox' as const },
        { browser: 'webkit' as const },
      ],
      commands: { dropConnections },
    },
  },
})

export default defineConfig({
  test: {
    testTimeout: 20_000,
    projects: [node('v13'), node('v14'), browser('v13'), browser('v14')],
  },
})
