'use strict';

const bcrypt = require('bcryptjs');
const config = require('../config');
const userRepo = require('../repositories/userRepo');
const tokenRepo = require('../repositories/tokenRepo');
const jwtUtil = require('../utils/jwt');
const hub = require('../ws/hub');
const { CLOSE } = require('../ws/protocol');
const { AppError } = require('../utils/errors');
const { createLogger } = require('../utils/logger');

const log = createLogger('auth');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const BCRYPT_ROUNDS = 10;

function assertCredentialsShape(username, password, { forRegister = false } = {}) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw AppError.badRequest('INVALID_USERNAME', '用户名需为 3-32 位字母、数字或下划线');
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
    throw AppError.badRequest('INVALID_PASSWORD', '密码长度需为 6-64 位');
  }
  if (forRegister && password.trim().length === 0) {
    throw AppError.badRequest('INVALID_PASSWORD', '密码不能为空白字符');
  }
}

/** Issues a fresh access/refresh pair and persists the refresh token hash. */
async function issueSession(user) {
  const accessToken = jwtUtil.signAccessToken(user);
  const { token: refreshToken, jti, expiresAt } = jwtUtil.signRefreshToken(user);
  await tokenRepo.insert({ userId: user.id, jti, token: refreshToken, expiresAt });
  return {
    accessToken,
    refreshToken,
    expiresIn: config.jwt.accessTtlSec,
    user: userRepo.toPublic(user),
  };
}

async function register({ username, password, nickname }) {
  assertCredentialsShape(username, password, { forRegister: true });
  const display = (nickname || username).toString().trim().slice(0, 64) || username;
  if (display.length === 0) throw AppError.badRequest('INVALID_NICKNAME', '昵称不能为空');

  const existing = await userRepo.findByUsername(username);
  if (existing) throw AppError.conflict('USERNAME_TAKEN', '该用户名已被注册');

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await userRepo.create({ username, passwordHash, nickname: display });
  log.info(`registered user=${user.id} ${username}`);
  return issueSession(user);
}

async function login({ username, password }) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw AppError.badRequest('INVALID_PAYLOAD', '请输入用户名和密码');
  }
  const user = await userRepo.findByUsername(username);
  // Constant-ish response regardless of which part failed.
  if (!user) throw AppError.unauthorized('BAD_CREDENTIALS', '用户名或密码错误');
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw AppError.unauthorized('BAD_CREDENTIALS', '用户名或密码错误');

  await userRepo.touchLastSeen(user.id);
  log.info(`login user=${user.id} ${username}`);
  return issueSession(user);
}

/**
 * Refresh-token rotation. The presented token is single-use: it is revoked and
 * replaced. Replaying an already-revoked token is treated as theft and revokes
 * the whole family of tokens for that user.
 */
async function refresh({ refreshToken }) {
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw AppError.unauthorized('NO_REFRESH_TOKEN', '缺少刷新令牌');
  }

  let payload;
  try {
    payload = jwtUtil.verifyRefreshToken(refreshToken);
  } catch (err) {
    throw AppError.unauthorized('REFRESH_INVALID', '刷新令牌无效或已过期');
  }
  if (payload.typ !== 'refresh' || !payload.jti) {
    throw AppError.unauthorized('REFRESH_INVALID', '刷新令牌类型错误');
  }

  const stored = await tokenRepo.findActiveByJti(payload.jti);
  if (!stored) {
    // Valid signature but unknown/revoked => reuse. Invalidate everything.
    await tokenRepo.revokeAllForUser(payload.sub);
    const user = await userRepo.incrementTokenVersion(payload.sub);
    hub.closeUser(payload.sub);
    log.warn(`refresh token reuse detected user=${payload.sub} -> revoked all sessions`);
    throw AppError.unauthorized('REFRESH_REUSED', '登录状态异常，请重新登录');
  }

  const user = await userRepo.findById(payload.sub);
  if (!user || Number(user.token_version) !== Number(payload.tv)) {
    await tokenRepo.revokeAllForUser(payload.sub);
    throw AppError.unauthorized('SESSION_REVOKED', '登录状态已失效，请重新登录');
  }

  await tokenRepo.revokeByJti(payload.jti);
  return issueSession(user);
}

/**
 * Global logout: bumps token_version (instantly invalidating every access AND
 * refresh token of the user) and force-closes all live sockets.
 *
 * The socket is closed with SESSION_REVOKED (not TOKEN_EXPIRED) so clients know
 * this is a deliberate logout and must NOT try to refresh/reconnect.
 */
async function logout({ userId }) {
  await tokenRepo.revokeAllForUser(userId);
  await userRepo.incrementTokenVersion(userId);
  hub.closeUser(userId, CLOSE.SESSION_REVOKED, 'logged out');
  log.info(`logout user=${userId} (all sessions revoked)`);
  return { ok: true };
}

async function me(userId) {
  const user = await userRepo.findById(userId);
  if (!user) throw AppError.unauthorized();
  return userRepo.toPublic(user);
}

module.exports = { register, login, refresh, logout, me, issueSession, assertCredentialsShape };
