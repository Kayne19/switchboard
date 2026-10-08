/// <reference types="vitest/config" />
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
  test: {
    // The wall-clock limit on one unit test is a hang detector, not a
    // budget: the heaviest tests (a dense chart's notes placed three times,
    // sixty random graphs) take 4-7 s
    // with two or three copies of the suite running at once, against the
    // default 5 s. Budgets are CPU time, in tests/unit/cpuTime.ts.
    testTimeout: 30_000,
    // The act-environment flag every jsdom test needs; the rest of the
    // shared harness is opt-in (tests/unit/sceneHarness.tsx).
    setupFiles: ['./tests/unit/setup.ts'],
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
      // of the runtime's WASM. The Silero endpointer (src/silero_vad.ts)
      // imports the runtime by the same specifier.
      external: ['openwakeword-wasm-browser', 'onnxruntime-web'],
    },
  },
});
