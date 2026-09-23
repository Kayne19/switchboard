import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 4173,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  build: {
    outDir: '../../static',
    emptyOutDir: false,
    assetsDir: 'v17-assets',
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      // The wake-word engine and ONNX Runtime are served as committed files
      // under /openwakeword/ and resolved through the import map in
      // index.html, so the bundle neither inlines them nor emits its own copy
      // of the runtime's WASM.
      external: ['openwakeword-wasm-browser'],
    },
  },
});
