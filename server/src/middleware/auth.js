'use strict';

const jwtUtil = require('../utils/jwt');
const userRepo = require('../repositories/userRepo');
const { AppError } = require('../utils/errors');

/** Pulls a bearer token from the Authorization header, else a `?token=` query. */
function resolveToken(req) {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  if (typeof req.query.token === 'string' && req.query.token.length > 0) return req.query.token.trim();
  return null;
}

/** Verifies a raw access token and returns the backing user row. */
async function authenticate(token) {
  let payload;
  try {
    payload = jwtUtil.verifyAccessToken(token);
  } catch (err) {
    const expired = err && err.name === 'TokenExpiredError';
    throw AppError.unauthorized(expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID', '登录凭证无效或已过期');
  }

  const user = await userRepo.findById(payload.sub);
  if (!user) throw AppError.unauthorized('USER_NOT_FOUND', '用户不存在');
  if (Number(user.token_version) !== Number(payload.tv)) {
    throw AppError.unauthorized('SESSION_REVOKED', '登录状态已失效，请重新登录');
  }
  return user;
}

/**
 * HTTP authentication guard. Attaches `req.user` (public shape) and `req.userId`.
 * Enforces the same token_version rule as the WebSocket handshake so a global
 * logout invalidates REST calls too.
 */
async function requireAuth(req, res, next) {
  try {
    const token = resolveToken(req);
    if (!token) throw AppError.unauthorized('NO_TOKEN', '缺少登录凭证');
    const user = await authenticate(token);
    req.user = userRepo.toPublic(user);
    req.userId = Number(user.id);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Same as `requireAuth` but also accepts the token from `?token=`. Needed for
 * resources a browser loads without custom headers (e.g. `<img src>`), matching
 * the WebSocket handshake's rationale.
 */
async function requireAuthFlexible(req, res, next) {
  try {
    const token = resolveToken(req);
    if (!token) throw AppError.unauthorized('NO_TOKEN', '缺少登录凭证');
    const user = await authenticate(token);
    req.user = userRepo.toPublic(user);
    req.userId = Number(user.id);
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, requireAuthFlexible };
