import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SharedWorker (`public/ws-worker.js`) and the shared engine
// (`public/realtime-engine.js`) are intentionally served as plain static assets
// and are NOT processed by the bundler — that keeps them byte-for-byte identical
// in dev and production and avoids worker-format pitfalls.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
