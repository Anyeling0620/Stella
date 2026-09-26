'use strict';

const express = require('express');
const noticeService = require('../services/noticeService');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();

/**
 * GET /api/system/notices?sinceId=
 * Cursor pull for system announcements — the polling-fallback counterpart of
 * the WebSocket `notice:system` push.
 */
router.get(
  '/notices',
  requireAuth,
  asyncHandler(async (req, res) => {
    const notices = await noticeService.listSince(Number(req.query.sinceId) || 0);
    res.json({ ok: true, data: { notices, serverTime: new Date().toISOString() } });
  })
);

/** GET /api/system/time — handy for clock-skew checks and demos. */
router.get('/time', (req, res) => {
  const now = new Date();
  res.json({
    ok: true,
    data: { serverTime: now.toISOString(), formatted: noticeService.formatServerTime(now) },
  });
});

module.exports = router;
