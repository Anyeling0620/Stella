'use strict';

const express = require('express');
const favoriteService = require('../services/favoriteService');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();
router.use(requireAuth);

/** GET /api/favorites — my saved messages (newest first). */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: { favorites: await favoriteService.list(req.userId) } });
  })
);

/** POST /api/favorites { messageId, srcConversation? } — snapshot a message. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const favorite = await favoriteService.add({
      userId: req.userId,
      messageId: body.messageId,
      srcConversation: body.srcConversation || null,
    });
    res.status(201).json({ ok: true, data: { favorite } });
  })
);

/** DELETE /api/favorites/:id */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await favoriteService.remove({ userId: req.userId, id: req.params.id }) });
  })
);

module.exports = router;
