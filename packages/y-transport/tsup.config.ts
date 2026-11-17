import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    y14: 'src/y14.ts',
    'server/index': 'src/server/index.ts',
    'server/y14': 'src/server/y14.ts',
    'server/ws': 'src/server/ws.ts',
    'server/webtransport': 'src/server/webtransport.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  external: [
    'yjs',
    'y-protocols',
    '@y/y',
    '@y/protocols',
    'y-append-log',
    'ws',
    '@fails-components/webtransport',
  ],
})
