import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The debug page is a second, separate build. The backend embeds exactly
// three files from `static-debug/` and serves them only on the debug
// listener, at `/`, `/debug.js`, and `/debug.css`, so the output names are
// fixed and everything else (dynamic imports, the fixture) is bundled into
// `debug.js`. The main page build is not touched.
export default defineConfig({
  root: `${import.meta.dirname}/debug`,
  base: '/',
  plugins: [react()],
  publicDir: false,
  server: {
    host: '0.0.0.0',
    port: 4174,
    proxy: {
      // `npm run dev:debug` against a running service's debug listener.
      '/ws': { target: process.env.SWITCHBOARD_DEBUG_ORIGIN ?? 'ws://127.0.0.1:8766', ws: true },
    },
  },
  build: {
    outDir: '../../../static-debug',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'debug.js',
        assetFileNames: (asset) => (asset.names.some((name) => name.endsWith('.css')) ? 'debug.css' : '[name][extname]'),
      },
    },
  },
});
