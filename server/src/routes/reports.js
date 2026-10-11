'use strict';

const express = require('express');
const reportService = require('../services/reportService');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();
router.use(requireAuth);

const reportLimit = rateLimit({ name: 'report', windowMs: 60 * 60 * 1000, max: 20, keyBy: (req) => req.userId });

/** POST /api/reports { targetType, targetId, reason, detail } */
router.post(
  '/',
  reportLimit,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const result = await reportService.create({
      reporterId: req.userId,
      targetType: body.targetType,
      targetId: body.targetId,
      reason: body.reason,
      detail: body.detail,
      ip: req.ip,
    });
    res.status(201).json({ ok: true, data: result });
  })
);

/** GET /api/reports/mine — the caller's own reports (receipt). */
router.get(
  '/mine',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: { reports: await reportService.listMine(req.userId) } });
  })
);

module.exports = router;
