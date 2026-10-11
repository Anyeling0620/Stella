import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SharedWorker (`public/realtime-worker.js`) and the shared engine
// (`public/realtime-engine.js`) are intentionally served as plain static assets
// and are NOT processed by the bundler — that keeps them byte-for-byte identical
// in dev and production and avoids worker-format pitfalls.

/**
 * The dev/preview server proxies `/api` and `/ws` to the backend so the app is
 * SAME-ORIGIN with the API. That is what makes the HttpOnly refresh cookie a
 * first-party `SameSite=Lax` cookie (a cross-site `localhost:5173` →
 * `127.0.0.1:3001` hop would silently drop it). Override the backend with
 * `VITE_API_PROXY_TARGET`.
 */
const API_TARGET = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3001';

const proxy = {
  '/api': { target: API_TARGET, changeOrigin: true },
  '/ws': { target: API_TARGET, ws: true, changeOrigin: true },
};

/**
 * Content-Security-Policy for the SPA. The production build allows only the
 * inline theme script's SHA-256 (computed from `index.html`); the dev server
 * additionally allows inline/eval because Vite's HMR client needs them.
 */
const CSP_HASH = "'sha256-nCULdzmRKOdZdQd1CKsp729ptlXSfJ+AtBnNuX5gfRY='";
const csp = (scriptExtra: string) =>
  [
    "default-src 'self'",
    `script-src 'self' ${scriptExtra}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

const cspDev = csp("'unsafe-inline' 'unsafe-eval'");
const cspProd = csp(CSP_HASH);

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
    proxy,
    headers: { 'Content-Security-Policy': cspDev },
  },
  preview: {
    port: 4173,
    host: true,
    proxy,
    headers: { 'Content-Security-Policy': cspProd },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
