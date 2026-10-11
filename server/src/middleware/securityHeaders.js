'use strict';

const helmet = require('helmet');
const config = require('../config');

/**
 * Security response headers (chapter 15).
 *
 * The API only ever returns JSON (plus attachment bytes), so its own CSP is the
 * strictest possible. The SPA's CSP is delivered by the static host / Vite dev
 * server (see `web/vite.config.ts`), because this process does not serve the
 * HTML in development.
 */
const isProd = config.env === 'production';

module.exports = helmet({
  // The API returns no HTML, so a maximally restrictive CSP is safe here.
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'none'"],
      'frame-ancestors': ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // attachments load from the app origin
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
  // frameguard = X-Frame-Options: DENY (clickjacking).
  frameguard: { action: 'deny' },
});
