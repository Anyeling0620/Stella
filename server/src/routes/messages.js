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
 * POST /api/messages { toUserId, content, clientMsgId }  (1:1)
 *                or  { groupId, content, clientMsgId, mentions }  (group)
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
      groupId: body.groupId,
      content: body.content,
      clientMsgId: body.clientMsgId,
      mentions: body.mentions,
      type: body.type,
      attachmentId: body.attachmentId,
      quoteId: body.quoteId,
    });
    res.status(201).json({ ok: true, data: { message } });
  })
);

/**
 * GET /api/messages/search?friendId=&groupId=&q=&from=&to=
 * In-conversation search. `q` matches text; `from`/`to` (ISO) bound a date
 * window (either alone browses that window, media included).
 */
router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const messages = await messageService.searchMessages({
      userId: req.userId,
      friendId: req.query.friendId,
      groupId: req.query.groupId,
      keyword: req.query.q,
      from: req.query.from,
      to: req.query.to,
    });
    res.json({ ok: true, data: { messages } });
  })
);

/** POST /api/messages/conversation/clear { peerKind, peerId } */
router.post(
  '/conversation/clear',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const result = await messageService.clearConversation({
      userId: req.userId,
      peerKind: body.peerKind,
      peerId: body.peerId,
    });
    res.json({ ok: true, data: result });
  })
);

/** POST /api/messages/:id/recall — ungated by the 2-minute window in the service. */
router.post(
  '/:id/recall',
  asyncHandler(async (req, res) => {
    const result = await messageService.recall({ userId: req.userId, messageId: req.params.id });
    res.json({ ok: true, data: result });
  })
);

/** POST /api/messages/:id/forward { targetUserIds, targetGroupIds } */
router.post(
  '/:id/forward',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const result = await messageService.forward({
      userId: req.userId,
      messageId: req.params.id,
      targetUserIds: body.targetUserIds,
      targetGroupIds: body.targetGroupIds,
    });
    res.json({ ok: true, data: result });
  })
);

/** DELETE /api/messages/:id — local delete (my view only). */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await messageService.deleteLocal({ userId: req.userId, messageId: req.params.id }) });
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
