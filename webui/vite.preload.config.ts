import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'desktop/preload.ts',
    outDir: 'dist-desktop',
    emptyOutDir: false,
    target: 'node22',
    rollupOptions: {
      external: ['electron'],
      output: { format: 'cjs', entryFileNames: 'preload.cjs' },
    },
  },
})
