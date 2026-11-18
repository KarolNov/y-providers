import { defineConfig } from 'vite'

// `--mode y14` serves the Yjs v14 entry, src/main.y14.ts, instead of src/main.ts.
export default defineConfig(({ mode }) => ({
  plugins: [
    {
      name: 'yjs-major',
      // 'pre', so the build bundles the swapped entry, not only the dev server.
      transformIndexHtml: {
        order: 'pre',
        handler: (html) =>
          mode === 'y14' ? html.replace('/src/main.ts', '/src/main.y14.ts') : html,
      },
    },
  ],
}))
