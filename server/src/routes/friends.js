'use strict';

const express = require('express');
const friendService = require('../services/friendService');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();

router.use(requireAuth);

/** Anti-骚扰 throttle: 30 friend requests per minute per user. */
const requestLimit = rateLimit({ name: 'friend', windowMs: 60 * 1000, max: 30, keyBy: (req) => req.userId });

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

/** POST /api/friends/requests { toUserId, message } — or { token } via invite link */
router.post(
  '/requests',
  requestLimit,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const result = body.token
      ? await friendService.sendRequestByInvite({
          fromUserId: req.userId,
          token: body.token,
          message: body.message,
        })
      : await friendService.sendRequest({
          fromUserId: req.userId,
          toUserId: body.toUserId,
          message: body.message,
        });
    // 201 when a pending request was created, 200 when it was auto-accepted.
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

// --- Blocks (拉黑) — declared before the `/:friendId` param route ----------
router.get(
  '/blocks',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: { blocks: await friendService.listBlocks(req.userId) } });
  })
);

router.post(
  '/blocks',
  asyncHandler(async (req, res) => {
    const result = await friendService.addBlock({ userId: req.userId, targetId: req.body && req.body.userId });
    res.status(201).json({ ok: true, data: result });
  })
);

router.delete(
  '/blocks/:id',
  asyncHandler(async (req, res) => {
    const result = await friendService.removeBlock({ userId: req.userId, targetId: req.params.id });
    res.json({ ok: true, data: result });
  })
);

// --- Invite links (邀请链接) -----------------------------------------------
router.get(
  '/invite-links',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: { links: await friendService.listInvites(req.userId) } });
  })
);

router.post(
  '/invite-links',
  asyncHandler(async (req, res) => {
    res.status(201).json({ ok: true, data: await friendService.createInvite(req.userId) });
  })
);

router.delete(
  '/invite-links/:token',
  asyncHandler(async (req, res) => {
    const result = await friendService.revokeInvite({ userId: req.userId, token: req.params.token });
    res.json({ ok: true, data: result });
  })
);

/** PATCH /api/friends/:friendId { remark } — private per-friend alias. */
router.patch(
  '/:friendId',
  asyncHandler(async (req, res) => {
    const result = await friendService.setRemark({
      userId: req.userId,
      friendId: req.params.friendId,
      remark: req.body && req.body.remark,
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
