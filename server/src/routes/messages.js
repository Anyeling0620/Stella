'use strict';

const express = require('express');
const messageService = require('../services/messageService');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();

router.use(requireAuth);

/**
 * GET /api/messages/history?friendId=&beforeId=&limit=
 * "Source A" of the dual-source strategy: the HTTP baseline of stored messages.
 */
router.get(
  '/history',
  asyncHandler(async (req, res) => {
    const data = await messageService.history({
      userId: req.userId,
      friendId: req.query.friendId,
      beforeId: Number(req.query.beforeId) || 0,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ ok: true, data });
  })
);

/**
 * GET /api/messages/poll?sinceId=&noticeSinceId=
 * Incremental cursor pull — used by the WebSocket degradation path, and by any
 * client that cannot hold a long connection. Only returns rows newer than the
 * supplied cursor.
 */
router.get(
  '/poll',
  asyncHandler(async (req, res) => {
    const data = await messageService.poll({
      userId: req.userId,
      sinceId: Number(req.query.sinceId) || 0,
      noticeSinceId: Number(req.query.noticeSinceId) || 0,
      limit: Number(req.query.limit) || 100,
    });
    res.json({ ok: true, data });
  })
);

/**
 * POST /api/messages { toUserId, content, clientMsgId }
 * HTTP send path, used when the WebSocket is unavailable. Persists and fans out
 * exactly like the WS `chat:send` handler (identical service call).
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const message = await messageService.send({
      fromUserId: req.userId,
      toUserId: body.toUserId,
      content: body.content,
      clientMsgId: body.clientMsgId,
    });
    res.status(201).json({ ok: true, data: { message } });
  })
);

/** POST /api/messages/read { ids: [] } — read receipts */
router.post(
  '/read',
  asyncHandler(async (req, res) => {
    const result = await messageService.markRead({
      userId: req.userId,
      ids: (req.body && req.body.ids) || [],
    });
    res.json({ ok: true, data: result });
  })
);

module.exports = router;
