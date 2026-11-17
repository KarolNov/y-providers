import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/y14.ts', 'src/core.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['yjs', '@y/y'],
})
