'use strict';

const express = require('express');
const conversationService = require('../services/conversationService');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();
router.use(requireAuth);

/** GET /api/conversations — pin/mute settings for the caller's conversations. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: { conversations: await conversationService.list(req.userId) } });
  })
);

/** PATCH /api/conversations/:peerKind/:peerId { pinned?, muted? } */
router.patch(
  '/:peerKind/:peerId',
  asyncHandler(async (req, res) => {
    const result = await conversationService.update({
      userId: req.userId,
      peerKind: req.params.peerKind,
      peerId: req.params.peerId,
      pinned: req.body && req.body.pinned,
      muted: req.body && req.body.muted,
    });
    res.json({ ok: true, data: result });
  })
);

/** POST /api/conversations/:peerKind/:peerId/clear — clear my history. */
router.post(
  '/:peerKind/:peerId/clear',
  asyncHandler(async (req, res) => {
    const result = await conversationService.clear({
      userId: req.userId,
      peerKind: req.params.peerKind,
      peerId: req.params.peerId,
    });
    res.json({ ok: true, data: result });
  })
);

module.exports = router;
