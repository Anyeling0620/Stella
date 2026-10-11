'use strict';

const bcrypt = require('bcryptjs');
const config = require('../config');
const userRepo = require('../repositories/userRepo');
const tokenRepo = require('../repositories/tokenRepo');
const sessionRepo = require('../repositories/sessionRepo');
const jwtUtil = require('../utils/jwt');
const contentFilter = require('./contentFilter');
const loginThrottle = require('./loginThrottle');
const auditService = require('./auditService');
const hub = require('../ws/hub');
const { CLOSE } = require('../ws/protocol');
const { AppError } = require('../utils/errors');
const { createLogger } = require('../utils/logger');

const log = createLogger('auth');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const BCRYPT_ROUNDS = 10;

function assertPasswordShape(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 64) {
    throw AppError.badRequest('INVALID_PASSWORD', '密码长度需为 6-64 位');
  }
}

function assertCredentialsShape(username, password, { forRegister = false } = {}) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw AppError.badRequest('INVALID_USERNAME', '用户名需为 3-32 位字母、数字或下划线');
  }
  assertPasswordShape(password);
  if (forRegister && password.trim().length === 0) {
    throw AppError.badRequest('INVALID_PASSWORD', '密码不能为空白字符');
  }
}

/** `rememberMe` picks between the short (1 day) and long (30 day) refresh TTL. */
const refreshTtlFor = (rememberMe) =>
  rememberMe ? config.jwt.rememberMeTtlSec : config.jwt.refreshTtlSec;

/**
 * Issues a fresh access/refresh pair. When `sessionId` is omitted a new login
 * lineage is created (register / login); when supplied the caller's existing
 * lineage is reused (refresh rotation), keeping per-device revocation intact.
 */
async function issueSession(user, { sessionId = null, userAgent = null, ip = null, ttlSec, replacedJti = null } = {}) {
  const sid = sessionId || sessionRepo.newSessionId();
  if (!sessionId) {
    await sessionRepo.create({ userId: user.id, sessionId: sid, userAgent, ip });
  }

  const ttl = Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : config.jwt.refreshTtlSec;
  const accessToken = jwtUtil.signAccessToken(user, { sid });
  const { token: refreshToken, jti, expiresAt } = jwtUtil.signRefreshToken(user, { sid, ttlSec: ttl });

  await tokenRepo.insert({ userId: user.id, jti, token: refreshToken, expiresAt, sessionId: sid });
  await sessionRepo.touchCurrentJti({ sessionId: sid, jti });
  if (replacedJti) await tokenRepo.revokeByJti(replacedJti, { replacedByJti: jti });

  return {
    accessToken,
    refreshToken,
    refreshExpiresAt: expiresAt,
    expiresIn: config.jwt.accessTtlSec,
    sessionId: sid,
    user: userRepo.toPublic(user),
  };
}

/** `account+ip` key for the login-failure throttle. */
const throttleKey = (username, ip) => `${String(username).toLowerCase()}|${ip || 'unknown'}`;

function assertAccountUsable(user) {
  if (user.banned) throw AppError.forbidden('ACCOUNT_BANNED', '账号已被封禁，请联系管理员');
}

async function register({ username, password, nickname, rememberMe }, ctx = {}) {
  assertCredentialsShape(username, password, { forRegister: true });
  const display = (nickname || username).toString().trim().slice(0, 64) || username;
  if (display.length === 0) throw AppError.badRequest('INVALID_NICKNAME', '昵称不能为空');
  contentFilter.assertClean(display, '昵称');

  const existing = await userRepo.findByUsername(username);
  if (existing) throw AppError.conflict('USERNAME_TAKEN', '该用户名已被注册');

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await userRepo.create({ username, passwordHash, nickname: display });
  log.info(`registered user=${user.id} ${username}`);
  void auditService.record({ actorId: user.id, action: 'auth.register', targetType: 'user', targetId: user.id, ip: ctx.ip });
  return issueSession(user, { userAgent: ctx.userAgent, ip: ctx.ip, ttlSec: refreshTtlFor(rememberMe) });
}

async function login({ username, password, rememberMe }, ctx = {}) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw AppError.badRequest('INVALID_PAYLOAD', '请输入用户名和密码');
  }

  const key = throttleKey(username, ctx.ip);
  loginThrottle.assertNotLocked(key);

  const user = await userRepo.findByUsername(username);
  // Constant-ish response regardless of which part failed.
  const ok = user && !user.deleted_at ? await bcrypt.compare(password, user.password_hash) : false;
  if (!ok) {
    loginThrottle.recordFailure(key);
    void auditService.record({ actorId: user ? user.id : null, action: 'auth.login_failed', ip: ctx.ip, meta: { username } });
    throw AppError.unauthorized('BAD_CREDENTIALS', '用户名或密码错误');
  }

  loginThrottle.clear(key);
  assertAccountUsable(user);
  await userRepo.touchLastSeen(user.id);
  log.info(`login user=${user.id} ${username}`);
  void auditService.record({ actorId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, ip: ctx.ip });
  return issueSession(user, { userAgent: ctx.userAgent, ip: ctx.ip, ttlSec: refreshTtlFor(rememberMe) });
}

/**
 * Refresh-token rotation. The presented token is single-use: it is revoked and
 * replaced. A replay long after rotation is treated as theft and revokes the
 * whole family; a re-presentation *within* a short grace window (two tabs share
 * one cookie and race the same refresh) is benign and simply re-issues.
 */
async function refresh({ refreshToken }, ctx = {}) {
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw AppError.unauthorized('NO_REFRESH_TOKEN', '缺少刷新令牌');
  }

  let payload;
  try {
    payload = jwtUtil.verifyRefreshToken(refreshToken);
  } catch {
    throw AppError.unauthorized('REFRESH_INVALID', '刷新令牌无效或已过期');
  }
  if (payload.typ !== 'refresh' || !payload.jti) {
    throw AppError.unauthorized('REFRESH_INVALID', '刷新令牌类型错误');
  }

  const stored = await tokenRepo.findByJti(payload.jti);
  if (!stored) {
    // Valid signature but unknown token: treat as reuse and burn everything.
    await revokeEverything(payload.sub);
    log.warn(`refresh token reuse detected user=${payload.sub} -> revoked all sessions`);
    throw AppError.unauthorized('REFRESH_REUSED', '登录状态异常，请重新登录');
  }
  if (new Date(stored.expires_at).getTime() <= Date.now()) {
    throw AppError.unauthorized('REFRESH_EXPIRED', '登录状态已过期，请重新登录');
  }

  const user = await userRepo.findById(payload.sub);
  if (!user || Number(user.token_version) !== Number(payload.tv) || user.deleted_at || user.banned) {
    await revokeEverything(payload.sub);
    throw AppError.unauthorized('SESSION_REVOKED', '登录状态已失效，请重新登录');
  }

  const session = stored.session_id ? await sessionRepo.findBySessionId(stored.session_id) : null;
  if (session && session.revoked) {
    throw AppError.unauthorized('SESSION_REVOKED', '该设备登录已失效，请重新登录');
  }

  if (stored.revoked) {
    const rotatedAt = stored.rotated_at ? new Date(stored.rotated_at).getTime() : 0;
    const withinGrace = rotatedAt > 0 && Date.now() - rotatedAt <= config.security.refreshGraceMs;
    if (withinGrace && stored.replaced_by_jti && session) {
      // Benign concurrent refresh from a sibling tab: mint a fresh pair for the
      // same lineage instead of nuking the account.
      return issueSession(user, { sessionId: session.session_id, userAgent: ctx.userAgent, ip: ctx.ip });
    }
    await revokeEverything(payload.sub);
    log.warn(`refresh token reuse detected user=${payload.sub} -> revoked all sessions`);
    throw AppError.unauthorized('REFRESH_REUSED', '登录状态异常，请重新登录');
  }

  // Active token: rotate, keeping the same lineage.
  return issueSession(user, {
    sessionId: session ? session.session_id : null,
    userAgent: ctx.userAgent,
    ip: ctx.ip,
    replacedJti: payload.jti,
  });
}

/** Global kill switch: revoke every token + session, bump version, drop sockets. */
async function revokeEverything(userId) {
  await tokenRepo.revokeAllForUser(userId);
  await sessionRepo.revokeAllForUser(userId);
  await userRepo.incrementTokenVersion(userId);
  hub.closeUser(userId, CLOSE.SESSION_REVOKED, 'session revoked');
}

/**
 * Global logout: bumps token_version (instantly invalidating every access AND
 * refresh token of the user) and force-closes all live sockets. Also revokes
 * every session row so the device list reflects the sign-out.
 */
async function logout({ userId }) {
  await tokenRepo.revokeAllForUser(userId);
  await sessionRepo.revokeAllForUser(userId);
  await userRepo.incrementTokenVersion(userId);
  hub.closeUser(userId, CLOSE.SESSION_REVOKED, 'logged out');
  log.info(`logout user=${userId} (all sessions revoked)`);
  void auditService.record({ actorId: userId, action: 'auth.logout', targetType: 'user', targetId: userId });
  return { ok: true };
}

/** Revokes exactly one login lineage — the "remote logout" from the device list. */
async function logoutSession({ userId, sessionId }) {
  const session = await sessionRepo.findBySessionId(sessionId);
  if (!session || Number(session.user_id) !== Number(userId)) {
    throw AppError.notFound('SESSION_NOT_FOUND', '会话不存在');
  }
  await sessionRepo.revoke({ userId, sessionId });
  await tokenRepo.revokeSession({ userId, sessionId });
  hub.closeSession(userId, sessionId, CLOSE.SESSION_REVOKED, 'remote logout');
  return { sessionId, revoked: true };
}

/** Revokes every session but the caller's own. */
async function revokeOtherSessions({ userId, currentSessionId }) {
  await sessionRepo.revokeOthers({ userId, keepSessionId: currentSessionId });
  await tokenRepo.revokeOthers({ userId, keepSessionId: currentSessionId });
  hub.closeOtherSessions(userId, currentSessionId, CLOSE.SESSION_REVOKED, 'other sessions revoked');
  return { ok: true };
}

async function listSessions({ userId, currentSessionId }) {
  const rows = await sessionRepo.listForUser(userId);
  return rows.map((r) => ({
    sessionId: r.session_id,
    userAgent: r.user_agent || null,
    ip: r.ip || null,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    current: r.session_id === currentSessionId,
    revoked: Boolean(r.revoked),
  }));
}

async function changePassword({ userId, currentSessionId, oldPassword, newPassword }) {
  const user = await userRepo.findById(userId);
  if (!user) throw AppError.unauthorized();
  const ok = await bcrypt.compare(String(oldPassword || ''), user.password_hash);
  if (!ok) throw AppError.badRequest('WRONG_PASSWORD', '当前密码不正确');
  assertPasswordShape(newPassword);
  if (newPassword === oldPassword) throw AppError.badRequest('SAME_PASSWORD', '新密码不能与当前密码相同');

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await userRepo.updatePassword(userId, passwordHash);
  // Every *other* device is signed out; the caller keeps this session.
  await sessionRepo.revokeOthers({ userId, keepSessionId: currentSessionId });
  await tokenRepo.revokeOthers({ userId, keepSessionId: currentSessionId });
  hub.closeOtherSessions(userId, currentSessionId, CLOSE.SESSION_REVOKED, 'password changed');
  log.info(`password changed user=${userId} (other sessions revoked)`);
  void auditService.record({ actorId: userId, action: 'auth.password_changed', targetType: 'user', targetId: userId });
  return { ok: true };
}

async function deleteAccount({ userId, password }) {
  const user = await userRepo.findById(userId);
  if (!user) throw AppError.unauthorized();
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) throw AppError.badRequest('WRONG_PASSWORD', '密码不正确');
  await userRepo.setDeleted(userId);
  await revokeEverything(userId);
  log.info(`account deleted user=${userId} (cooling period)`);
  void auditService.record({ actorId: userId, action: 'auth.account_deleted', targetType: 'user', targetId: userId });
  return { ok: true, coolingDays: Math.round(config.security.accountCoolingMs / 86400000) };
}

/** Restores a soft-deleted account within the cooling window. */
async function restoreAccount({ username, password }, ctx = {}) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw AppError.badRequest('INVALID_PAYLOAD', '请输入用户名和密码');
  }
  const user = await userRepo.findByUsername(username);
  const ok = user && user.deleted_at ? await bcrypt.compare(password, user.password_hash) : false;
  if (!ok) throw AppError.unauthorized('BAD_CREDENTIALS', '用户名或密码错误');
  const deletedAt = new Date(user.deleted_at).getTime();
  if (Date.now() - deletedAt > config.security.accountCoolingMs) {
    throw AppError.forbidden('COOLING_EXPIRED', '账号已超过找回期限，无法恢复');
  }
  await userRepo.clearDeleted(user.id);
  await userRepo.touchLastSeen(user.id);
  const fresh = await userRepo.findById(user.id);
  log.info(`account restored user=${user.id}`);
  return issueSession(fresh, { userAgent: ctx.userAgent, ip: ctx.ip });
}

async function me(userId) {
  const user = await userRepo.findById(userId);
  if (!user) throw AppError.unauthorized();
  return userRepo.toPublic(user);
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  logoutSession,
  revokeOtherSessions,
  listSessions,
  changePassword,
  deleteAccount,
  restoreAccount,
  me,
  issueSession,
  assertCredentialsShape,
  refreshTtlFor,
};
