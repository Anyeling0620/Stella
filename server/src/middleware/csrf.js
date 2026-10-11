'use strict';

const crypto = require('crypto');
const config = require('../config');
const { isAllowedOrigin } = require('../utils/origin');
const { AppError } = require('../utils/errors');

/**
 * CSRF defence for the cookie-authenticated endpoints (`/api/auth/refresh`).
 *
 * Every other route is Bearer-authenticated — a browser never attaches the
 * Authorization header by itself — so it is not CSRF-exposed. Only the refresh
 * (and any future cookie-driven) endpoint needs guarding.
 *
 * Two layers:
 *   1. Origin/Referer allowlist — a cross-site page cannot forge these.
 *   2. Double-submit token — the server sets a non-HttpOnly `stella_csrf`
 *      cookie; the client must echo it in `X-CSRF-Token`. An attacker page can
 *      neither read the cookie nor set the custom header (preflight).
 *
 * Non-browser clients (curl, the server e2e harness) carry no CSRF cookie and no
 * Origin; those are allowed to present the refresh token in the body instead.
 */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function csrfGuard(req, res, next) {
  const origin = req.headers['origin'];
  if (!isAllowedOrigin(origin)) {
    return next(AppError.forbidden('CSRF_ORIGIN', '请求来源不被允许'));
  }

  const cookieToken = req.cookies ? req.cookies[config.security.csrfCookieName] : null;
  // No CSRF cookie => not a browser cookie-flow request; the refresh token must
  // then be supplied in the body (Bearer-style clients), so CSRF does not apply.
  if (!cookieToken) return next();

  const headerToken = req.headers['x-csrf-token'];
  if (!headerToken || !safeEqual(headerToken, cookieToken)) {
    return next(AppError.forbidden('CSRF_FAILED', 'CSRF 校验失败，请刷新页面后重试'));
  }
  next();
}

module.exports = { csrfGuard };
