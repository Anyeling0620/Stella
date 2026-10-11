'use strict';

const express = require('express');
const userSettingsRepo = require('../repositories/userSettingsRepo');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();
router.use(requireAuth);

const BOOLEAN_KEYS = [
  'addByUsername',
  'addByInvite',
  'addByGroup',
  'requireVerification',
  'notifyDesktop',
  'notifySound',
  'notifyPreview',
];

/** GET /api/settings — privacy + notification switches (defaults if unset). */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: { settings: await userSettingsRepo.get(req.userId) } });
  })
);

/** PATCH /api/settings — only known boolean keys are accepted. */
router.patch(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const patch = {};
    for (const key of BOOLEAN_KEYS) {
      if (body[key] !== undefined) patch[key] = Boolean(body[key]);
    }
    res.json({ ok: true, data: { settings: await userSettingsRepo.upsert(req.userId, patch) } });
  })
);

module.exports = router;
