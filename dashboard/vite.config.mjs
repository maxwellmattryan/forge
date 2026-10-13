// @ts-check
// Build-time only: `npm run build:dashboard` compiles index.html, style.css and the modules into
// the committed dist/. The installed plugin never loads Vite; the server reads dist/ directly.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  // /forge.png is served by the server from assets/, so nothing is copied into dist/.
  publicDir: false,
  plugins: [tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The server's allowlist: only files this manifest names are ever served.
    manifest: 'manifest.json',
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
});
