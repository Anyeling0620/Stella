'use strict';

const express = require('express');
const authService = require('../services/authService');
const userService = require('../services/userService');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const session = await authService.register(req.body || {});
    res.status(201).json({ ok: true, data: session });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const session = await authService.login(req.body || {});
    res.json({ ok: true, data: session });
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const session = await authService.refresh(req.body || {});
    res.json({ ok: true, data: session });
  })
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await authService.logout({ userId: req.userId });
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
 * PATCH /api/auth/me { nickname?, avatar? }
 * Both fields are optional; only the ones present are written. `avatar: null`
 * clears the avatar and falls back to the initials rendering.
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
    });
    res.json({ ok: true, data: result });
  })
);

module.exports = router;
