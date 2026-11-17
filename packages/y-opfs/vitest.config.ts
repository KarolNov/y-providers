import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const browserTests = 'src/**/__tests__/*.browser.test.ts'
const privateBrowsingTests = 'src/**/__tests__/*.private-browsing.test.ts'

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url))

type Major = 'v13' | 'v14'

/** `#entry` is the entry under test, `#y` its test helpers, `#log` the y-append-log entry of the same major. */
const alias = (major: Major) => ({
  '#entry': src(major === 'v13' ? 'index.ts' : 'y14.ts'),
  '#y': src(`__tests__/y/${major}.ts`),
  '#log': major === 'v13' ? 'y-append-log' : 'y-append-log/y14',
})

const node = (major: Major) => ({
  resolve: { alias: alias(major) },
  test: {
    name: `node-${major}`,
    environment: 'node' as const,
    include: ['src/**/__tests__/*.test.ts'],
    exclude: [browserTests, privateBrowsingTests],
  },
})

const browser = (major: Major) => ({
  resolve: { alias: alias(major) },
  test: {
    name: `browser-${major}`,
    include: [browserTests],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [
        { browser: 'chromium' as const },
        { browser: 'firefox' as const },
        // Playwright's default WebKit context is non-persistent, like a Safari private
        // window, and OPFS fails there. A profile on disk gives WebKit real OPFS; the
        // provider only uses it when the files run one at a time.
        {
          browser: 'webkit' as const,
          fileParallelism: false,
          provider: playwright({
            persistentContext: mkdtempSync(join(tmpdir(), `y-opfs-webkit-${major}-`)),
          }),
        },
      ],
    },
  },
})

const privateBrowsing = (major: Major) => ({
  resolve: { alias: alias(major) },
  test: {
    name: `private-browsing-${major}`,
    include: [privateBrowsingTests],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'webkit' as const }],
    },
  },
})

export default defineConfig({
  test: {
    projects: [
      node('v13'),
      node('v14'),
      browser('v13'),
      browser('v14'),
      privateBrowsing('v13'),
      privateBrowsing('v14'),
    ],
  },
})
