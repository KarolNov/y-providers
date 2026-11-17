import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url))

/** Every test runs once per Yjs major: `#entry` is the entry under test, `#y` its test helpers. */
const major = (name: 'v13' | 'v14', entry: string) => ({
  resolve: { alias: { '#entry': src(entry), '#y': src(`__tests__/y/${name}.ts`) } },
  test: { name, environment: 'node' as const, include: ['src/**/__tests__/*.test.ts'] },
})

export default defineConfig({
  test: { projects: [major('v13', 'index.ts'), major('v14', 'y14.ts')] },
})
