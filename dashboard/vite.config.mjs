// @ts-check
// Build-time only: `npm run build:dashboard` compiles index.html, style.css and the Svelte app into
// the committed dist/. The installed plugin never loads Vite; the server reads dist/ directly.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  // /forge.png is served by the server from assets/, so nothing is copied into dist/.
  publicDir: false,
  plugins: [tailwindcss(), svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The server's allowlist: only files this manifest names are ever served.
    manifest: 'manifest.json',
    sourcemap: false,
    modulePreload: { polyfill: false },
    // Any SVG a stylesheet references is inlined as a data: URI, so the server never has to serve
    // SVG (its allowlist rejects it); every other asset keeps Vite's default size rule.
    assetsInlineLimit: (file) => (file.endsWith('.svg') ? true : undefined),
  },
});
