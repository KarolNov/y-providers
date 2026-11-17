import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/y14.ts', 'src/node.ts', 'src/worker.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['yjs', '@y/y', 'y-append-log'],
})
