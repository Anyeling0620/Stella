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
    // Listen on all addresses. Without this Vite binds only the loopback name
    // Node resolves `localhost` to (::1 here), while browsers may resolve it to
    // 127.0.0.1 — so `http://localhost:5173` would be refused. `true` covers
    // both stacks (and allows testing from another device on the LAN).
    host: true,
  },
  preview: {
    port: 4173,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
