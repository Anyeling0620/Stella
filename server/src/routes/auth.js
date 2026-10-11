'use strict';

const crypto = require('crypto');
const express = require('express');
const authService = require('../services/authService');
const userService = require('../services/userService');
const { requireAuth } = require('../middleware/auth');
const { csrfGuard } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');
const { asyncHandler } = require('../utils/errors');
const { setRefreshCookie, clearRefreshCookie, readRefreshCookie, setCsrfCookie } = require('../utils/cookies');

const router = express.Router();

/** Cookie context for the auth service (device fingerprint + client IP). */
const ctxOf = (req) => ({ userAgent: req.headers['user-agent'] || null, ip: req.ip || null });

const byIpAndUser = (req) => `${req.ip || 'unknown'}|${(req.body && req.body.username) || ''}`;
const registerLimit = rateLimit({ name: 'register', windowMs: 15 * 60 * 1000, max: 10, keyBy: byIpAndUser });
const loginLimit = rateLimit({ name: 'login', windowMs: 15 * 60 * 1000, max: 10, keyBy: byIpAndUser });
const refreshLimit = rateLimit({ name: 'refresh', windowMs: 15 * 60 * 1000, max: 60, keyBy: (req) => req.ip });
const restoreLimit = rateLimit({ name: 'restore', windowMs: 15 * 60 * 1000, max: 10, keyBy: byIpAndUser });

/** Strips the refresh token from the body — it travels only in the cookie. */
function respondSession(res, session, status = 200) {
  const ttlSec = Math.max(1, Math.round((new Date(session.refreshExpiresAt).getTime() - Date.now()) / 1000));
  setRefreshCookie(res, session.refreshToken, ttlSec);
  // Non-HttpOnly double-submit token for CSRF defence on cookie endpoints.
  setCsrfCookie(res, crypto.randomBytes(24).toString('base64url'));
  res.status(status).json({
    ok: true,
    data: {
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    },
  });
}

router.post(
  '/register',
  registerLimit,
  asyncHandler(async (req, res) => {
    const session = await authService.register(req.body || {}, ctxOf(req));
    respondSession(res, session, 201);
  })
);

router.post(
  '/login',
  loginLimit,
  asyncHandler(async (req, res) => {
    const session = await authService.login(req.body || {}, ctxOf(req));
    respondSession(res, session);
  })
);

/**
 * Refresh reads the token from the HttpOnly cookie (browsers) and falls back to
 * a body `refreshToken` for non-browser clients. On any failure the cookie is
 * cleared so a wedged client does not loop on a dead token.
 */
router.post(
  '/refresh',
  csrfGuard,
  refreshLimit,
  asyncHandler(async (req, res) => {
    const refreshToken = readRefreshCookie(req) || (req.body && req.body.refreshToken);
    try {
      const session = await authService.refresh({ refreshToken }, ctxOf(req));
      respondSession(res, session);
    } catch (err) {
      clearRefreshCookie(res);
      throw err;
    }
  })
);

/** Restores a soft-deleted account within the cooling window (unauthenticated). */
router.post(
  '/restore',
  restoreLimit,
  asyncHandler(async (req, res) => {
    const session = await authService.restoreAccount(req.body || {}, ctxOf(req));
    respondSession(res, session);
  })
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await authService.logout({ userId: req.userId });
    clearRefreshCookie(res);
    res.json({ ok: true, data: result });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await authService.me(req.userId);
    res.json({ ok: true, data: { user } });
  })
);

/**
 * PATCH /api/auth/me { nickname?, avatar?, bio? }
 * Only the fields present are written. `avatar: null` clears the avatar.
 */
router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const result = await userService.updateProfile({
      userId: req.userId,
      nickname: body.nickname,
      avatar: body.avatar,
      bio: body.bio,
    });
    res.json({ ok: true, data: result });
  })
);

/** DELETE /api/auth/me { password } — 注销账号 (soft delete + cooling period). */
router.delete(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const password = req.body && req.body.password;
    const result = await authService.deleteAccount({ userId: req.userId, password });
    clearRefreshCookie(res);
    res.json({ ok: true, data: result });
  })
);

/** POST /api/auth/password { oldPassword, newPassword } */
router.post(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const result = await authService.changePassword({
      userId: req.userId,
      currentSessionId: req.sid,
      oldPassword: body.oldPassword,
      newPassword: body.newPassword,
    });
    res.json({ ok: true, data: result });
  })
);

/** Active sessions (device list). */
router.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const sessions = await authService.listSessions({ userId: req.userId, currentSessionId: req.sid });
    res.json({ ok: true, data: { sessions } });
  })
);

/** Remote logout of one device. */
router.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await authService.logoutSession({ userId: req.userId, sessionId: req.params.id });
    res.json({ ok: true, data: result });
  })
);

/** Sign out every other device. */
router.post(
  '/sessions/revoke-others',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await authService.revokeOtherSessions({ userId: req.userId, currentSessionId: req.sid });
    res.json({ ok: true, data: result });
  })
);

module.exports = router;
