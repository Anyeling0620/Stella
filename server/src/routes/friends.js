'use strict';

const express = require('express');
const friendService = require('../services/friendService');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();

router.use(requireAuth);

/** GET /api/friends — my friend list */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const friends = await friendService.listFriends(req.userId);
    res.json({ ok: true, data: { friends } });
  })
);

/** GET /api/friends/search?q=alice — search users I am not yet friends with */
router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const users = await friendService.search({ userId: req.userId, keyword: req.query.q });
    res.json({ ok: true, data: { users } });
  })
);

/** GET /api/friends/requests — pending requests in both directions */
router.get(
  '/requests',
  asyncHandler(async (req, res) => {
    const requests = await friendService.listRequests(req.userId);
    res.json({ ok: true, data: { requests } });
  })
);

/** POST /api/friends/requests { toUserId, message } */
router.post(
  '/requests',
  asyncHandler(async (req, res) => {
    const result = await friendService.sendRequest({
      fromUserId: req.userId,
      toUserId: req.body && req.body.toUserId,
      message: req.body && req.body.message,
    });
    // 201 when a pending request was created, 200 when an inbound pending
    // request was auto-accepted instead (no new resource was created).
    const status = result.outcome === 'auto-accepted' ? 200 : 201;
    res.status(status).json({ ok: true, data: result });
  })
);

/** POST /api/friends/requests/:id/accept | /reject */
router.post(
  '/requests/:id/:action',
  asyncHandler(async (req, res) => {
    const result = await friendService.respond({
      userId: req.userId,
      requestId: Number(req.params.id),
      action: req.params.action,
    });
    res.json({ ok: true, data: result });
  })
);

/**
 * DELETE /api/friends/:friendId
 * One-way removal: drops only the caller's row. The peer keeps their side, so
 * they still see the caller and the thread stays usable both ways.
 * Idempotent — removing a non-friend returns 200 with `removed: false`.
 */
router.delete(
  '/:friendId',
  asyncHandler(async (req, res) => {
    const result = await friendService.removeFriend({
      userId: req.userId,
      friendId: req.params.friendId,
    });
    res.json({ ok: true, data: result });
  })
);

module.exports = router;
