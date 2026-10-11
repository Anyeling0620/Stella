'use strict';

const config = require('../config');

/**
 * Origin allowlist shared by the CSRF guard and the WebSocket upgrade check.
 *
 * The configured CORS origins are always allowed. Outside production, any
 * `localhost`/`127.0.0.1` port is also allowed so the Vite dev/preview proxy
 * (which may bind an arbitrary port) works without editing the allowlist —
 * production stays strict.
 */
function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / non-browser clients send no Origin
  if (config.cors.origins.includes(origin)) return true;
  if (config.env !== 'production') {
    try {
      const { hostname } = new URL(origin);
      if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    } catch {
      /* malformed Origin -> not allowed */
    }
  }
  return false;
}

module.exports = { isAllowedOrigin };
