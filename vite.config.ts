import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const r = (p: string) => resolve(import.meta.dirname, p)

export default defineConfig(({ command, mode }) => {
  // `pnpm dev` / `vite build --mode examples` (GitHub Pages): example app, package imported straight from src
  if(command === 'serve' || mode === 'examples') return {
    root: r('examples'),
    base: './', // relative asset paths: works under /react-seismic-graph/ on GitHub Pages
    plugins: [react()],
    server: {
      port: 7000,
      host: true,
    },
    build: {
      outDir: r('site'),
      emptyOutDir: true,
      rollupOptions: { input: { index: r('examples/index.html'), vanilla: r('examples/vanilla.html') } },
    },
    resolve: {
      alias: [
        { find: /^react-seismic-graph\/react$/, replacement: r('src/react/index.ts') },
        { find: /^react-seismic-graph\/seisplotjs$/, replacement: r('src/seisplotjs/index.ts') },
        { find: /^react-seismic-graph$/, replacement: r('src/index.ts') },
      ],
    },
  }
  // `vite build --mode iife`: core only, one file for a plain <script> tag (global SeismicGraph)
  if(mode === 'iife') return {
    build: {
      emptyOutDir: false,
      lib: { entry: r('src/index.ts'), name: 'SeismicGraph', formats: ['iife'], fileName: () => 'seismic-graph.iife.js' },
    },
  }
  return {
    plugins: [react()],
    build: {
      sourcemap: true,
      lib: {
        entry: { index: r('src/index.ts'), react: r('src/react/index.ts'), seisplotjs: r('src/seisplotjs/index.ts') },
        formats: ['es', 'cjs'],
      },
      rollupOptions: { external: [/^react($|\/)/, /^react-dom($|\/)/, /^seisplotjs($|\/)/] },
    },
  }
})
