'use strict';

const express = require('express');
const groupService = require('../services/groupService');
const messageService = require('../services/messageService');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { asyncHandler } = require('../utils/errors');

const router = express.Router();

router.use(requireAuth);

/** Anti-abuse throttle: 10 group creations per hour per user. */
const createLimit = rateLimit({ name: 'group-create', windowMs: 60 * 60 * 1000, max: 10, keyBy: (req) => req.userId });

/** GET /api/groups — my groups with unread counts and last message. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const groups = await groupService.list(req.userId);
    res.json({ ok: true, data: { groups } });
  })
);

/** POST /api/groups { name, memberIds: [] } — create and pull friends in. */
router.post(
  '/',
  createLimit,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const group = await groupService.createGroup({
      ownerId: req.userId,
      name: body.name,
      memberIds: body.memberIds,
    });
    res.status(201).json({ ok: true, data: { group } });
  })
);

/** GET /api/groups/search?q= — find groups by 群号 / name (QQ-style). */
router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const groups = await groupService.search({ userId: req.userId, keyword: req.query.q });
    res.json({ ok: true, data: { groups } });
  })
);

/** GET /api/groups/:id — group detail with the member roster. */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = await groupService.detail({ userId: req.userId, groupId: req.params.id });
    res.json({ ok: true, data });
  })
);

/** PATCH /api/groups/:id { name?, avatar?, announcement? } — owner only. */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const group = await groupService.update({
      userId: req.userId,
      groupId: req.params.id,
      patch: req.body || {},
    });
    res.json({ ok: true, data: { group } });
  })
);

/** GET /api/groups/:id/messages?beforeId=&limit= — member-only history. */
router.get(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const data = await messageService.groupHistory({
      userId: req.userId,
      groupId: req.params.id,
      beforeId: Number(req.query.beforeId) || 0,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ ok: true, data });
  })
);

/** POST /api/groups/:id/members { userIds: [] } — owner adds friends. */
router.post(
  '/:id/members',
  asyncHandler(async (req, res) => {
    const result = await groupService.addMembers({
      userId: req.userId,
      groupId: req.params.id,
      userIds: (req.body && req.body.userIds) || [],
    });
    res.json({ ok: true, data: result });
  })
);

/** DELETE /api/groups/:id/members/:userId — owner removes a member. */
router.delete(
  '/:id/members/:userId',
  asyncHandler(async (req, res) => {
    const result = await groupService.removeMember({
      userId: req.userId,
      groupId: req.params.id,
      memberId: req.params.userId,
    });
    res.json({ ok: true, data: result });
  })
);

/** PATCH /api/groups/:id/members/me { nickname } — set my 群昵称. */
router.patch(
  '/:id/members/me',
  asyncHandler(async (req, res) => {
    const result = await groupService.setGroupNickname({
      userId: req.userId,
      groupId: req.params.id,
      nickname: req.body && req.body.nickname,
    });
    res.json({ ok: true, data: result });
  })
);

/** PATCH /api/groups/:id/members/:userId/role { role } — owner appoints admin. */
router.patch(
  '/:id/members/:userId/role',
  asyncHandler(async (req, res) => {
    const result = await groupService.setMemberRole({
      userId: req.userId,
      groupId: req.params.id,
      memberId: req.params.userId,
      role: req.body && req.body.role,
    });
    res.json({ ok: true, data: result });
  })
);

/** GET /api/groups/:id/files — files shared in the group. */
router.get(
  '/:id/files',
  asyncHandler(async (req, res) => {
    const files = await groupService.listFiles({ userId: req.userId, groupId: req.params.id });
    res.json({ ok: true, data: { files } });
  })
);

/** POST /api/groups/:id/read { lastMessageId } — advance my read cursor. */
router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const result = await messageService.readGroup({
      userId: req.userId,
      groupId: req.params.id,
      lastMessageId: req.body && req.body.lastMessageId,
    });
    res.json({ ok: true, data: result });
  })
);

/** POST /api/groups/:id/join-requests { message } — apply to join (QQ-style). */
router.post(
  '/:id/join-requests',
  asyncHandler(async (req, res) => {
    const result = await groupService.requestJoin({
      userId: req.userId,
      groupId: req.params.id,
      message: req.body && req.body.message,
    });
    res.status(201).json({ ok: true, data: result });
  })
);

/** GET /api/groups/:id/join-requests — pending applications (owner only). */
router.get(
  '/:id/join-requests',
  asyncHandler(async (req, res) => {
    const requests = await groupService.listJoinRequests({ userId: req.userId, groupId: req.params.id });
    res.json({ ok: true, data: { requests } });
  })
);

/** POST /api/groups/:id/join-requests/:requestId/approve | /reject — owner only. */
router.post(
  '/:id/join-requests/:requestId/:action',
  asyncHandler(async (req, res) => {
    const result = await groupService.respondJoin({
      userId: req.userId,
      groupId: req.params.id,
      requestId: Number(req.params.requestId),
      action: req.params.action,
    });
    res.json({ ok: true, data: result });
  })
);

/** POST /api/groups/:id/leave — leave voluntarily (owner leaving dissolves). */
router.post(
  '/:id/leave',
  asyncHandler(async (req, res) => {
    const result = await groupService.leave({ userId: req.userId, groupId: req.params.id });
    res.json({ ok: true, data: result });
  })
);

/** DELETE /api/groups/:id — owner dissolves the group. */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const result = await groupService.dissolve({ userId: req.userId, groupId: req.params.id });
    res.json({ ok: true, data: result });
  })
);

module.exports = router;
