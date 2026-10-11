'use strict';

const config = require('../config');

/**
 * Refresh-token cookie plumbing.
 *
 * The refresh token lives in an HttpOnly cookie (never in JS-readable storage),
 * scoped to the auth routes so it is not attached to ordinary API calls. The
 * access token stays in memory on the client.
 *
 * NOTE: `res.clearCookie` must be given the *same* `path`/`sameSite`/`secure`
 * as when the cookie was set, or the browser will not clear it.
 */
const COOKIE_PATH = '/api/auth';

function baseOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.security.cookieSecure,
    path: COOKIE_PATH,
  };
}

function setRefreshCookie(res, token, ttlSec) {
  const maxAge = ttlSec * 1000;
  res.cookie(config.security.cookieName, token, {
    ...baseOptions(),
    maxAge,
    expires: new Date(Date.now() + maxAge),
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(config.security.cookieName, baseOptions());
}

function readRefreshCookie(req) {
  return req.cookies ? req.cookies[config.security.cookieName] : undefined;
}

// --- CSRF double-submit cookie (readable by JS on purpose) ------------------
function setCsrfCookie(res, token) {
  res.cookie(config.security.csrfCookieName, token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: config.security.cookieSecure,
    path: '/',
  });
}

module.exports = {
  COOKIE_PATH,
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
  setCsrfCookie,
};
