'use strict';

const express = require('express');
const pushService = require('../services/pushService');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();
router.use(requireAuth);

/** GET /api/push/public-key — VAPID public key + whether push is available. */
router.get(
  '/public-key',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: { enabled: pushService.isEnabled(), publicKey: pushService.publicKey() } });
  })
);

/** POST /api/push/subscribe { subscription } */
router.post(
  '/subscribe',
  asyncHandler(async (req, res) => {
    const result = await pushService.subscribe({
      userId: req.userId,
      subscription: req.body && req.body.subscription,
      userAgent: req.headers['user-agent'] || null,
    });
    res.status(201).json({ ok: true, data: result });
  })
);

/** POST /api/push/unsubscribe { endpoint } */
router.post(
  '/unsubscribe',
  asyncHandler(async (req, res) => {
    const result = await pushService.unsubscribe({ endpoint: req.body && req.body.endpoint });
    res.json({ ok: true, data: result });
  })
);

module.exports = router;
