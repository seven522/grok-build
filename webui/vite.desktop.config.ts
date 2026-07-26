import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'desktop/main.ts',
    outDir: 'dist-desktop',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      external: ['electron'],
      output: { format: 'es', entryFileNames: 'main.mjs' },
    },
  },
})
