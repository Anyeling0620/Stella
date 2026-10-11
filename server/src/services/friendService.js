'use strict';

const friendRepo = require('../repositories/friendRepo');
const userRepo = require('../repositories/userRepo');
const blockRepo = require('../repositories/blockRepo');
const userSettingsRepo = require('../repositories/userSettingsRepo');
const inviteLinkRepo = require('../repositories/inviteLinkRepo');
const contentFilter = require('./contentFilter');
const accountGuard = require('./accountGuard');
const hub = require('../ws/hub');
const presenceService = require('./presenceService');
const config = require('../config');
const { SERVER } = require('../ws/protocol');
const { AppError } = require('../utils/errors');
const { createLogger } = require('../utils/logger');

const log = createLogger('friend');

const REMARK_MAX = 64;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

/** Enforces the per-user friend cap (default 2000). */
async function assertFriendCapacity(userId) {
  const count = await friendRepo.countFriends(userId);
  if (count >= config.security.maxFriends) {
    throw AppError.forbidden('FRIEND_LIMIT', `好友数量已达上限（${config.security.maxFriends} 人），请先清理`);
  }
}

async function search({ userId, keyword }) {
  const q = (keyword || '').toString().trim();
  if (q.length === 0) return [];
  return userRepo.search({ userId, keyword: q.slice(0, 32), limit: 20 });
}

/** Sends (or re-sends) a friend request and notifies the recipient over WS. */
async function sendRequest({ fromUserId, toUserId, message, channel = 'username' }) {
  const targetId = Number(toUserId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw AppError.badRequest('INVALID_TARGET', '目标用户不存在');
  }
  if (targetId === Number(fromUserId)) {
    throw AppError.badRequest('SELF_REQUEST', '不能添加自己为好友');
  }
  await accountGuard.assertNotRestricted(fromUserId, '添加好友');

  const target = await userRepo.findPublicById(targetId);
  if (!target) throw AppError.notFound('USER_NOT_FOUND', '目标用户不存在');

  // Blocked in either direction => silent no.
  if (await blockRepo.hasAnyBlock(fromUserId, targetId)) {
    throw AppError.forbidden('BLOCKED', '对方已拒绝添加，或你已将其拉黑');
  }
  if (await friendRepo.areFriends(fromUserId, targetId)) {
    throw AppError.conflict('ALREADY_FRIENDS', '你们已经是好友了');
  }

  // The target's "添加我的方式" switches decide which channels are allowed.
  const targetSettings = await userSettingsRepo.get(targetId);
  const allowed =
    channel === 'invite' ? targetSettings.addByInvite : channel === 'group' ? targetSettings.addByGroup : targetSettings.addByUsername;
  if (!allowed) {
    throw AppError.forbidden('ADD_DISABLED', '对方已关闭该添加方式');
  }

  await assertFriendCapacity(fromUserId);

  // If the other side already requested us, accept instead of creating a
  // mirrored pending request. The caller must be able to tell the two outcomes
  // apart, so the result is discriminated (`outcome`).
  const inbound = await friendRepo.findRequestBetween(targetId, fromUserId);
  if (inbound && inbound.status === 'pending') {
    const accepted = await respond({ userId: fromUserId, requestId: inbound.id, action: 'accept' });
    return { outcome: 'auto-accepted', friend: accepted.friend };
  }

  // "是否需要验证" off => establish the friendship immediately.
  if (!targetSettings.requireVerification) {
    await friendRepo.insertPair(fromUserId, targetId);
    const from = await userRepo.findPublicById(fromUserId);
    const payloadFor = (self, other) => ({
      type: SERVER.FRIEND_ACCEPTED,
      requestId: null,
      friend: userRepo.toPublic(other),
      self: userRepo.toPublic(self),
    });
    hub.sendToUser(fromUserId, payloadFor(from, target));
    hub.sendToUser(targetId, payloadFor(target, from));
    log.info(`friend auto-accepted (no verification) ${fromUserId} <-> ${targetId}`);
    return { outcome: 'auto-accepted', friend: userRepo.toPublic(target) };
  }

  const request = await friendRepo.upsertRequest({
    fromUserId,
    toUserId: targetId,
    message: (message || '').toString().trim().slice(0, 255) || null,
  });

  const from = await userRepo.findPublicById(fromUserId);
  const base = {
    id: Number(request.id),
    status: request.status,
    message: request.message,
    createdAt: request.created_at,
  };

  // The recipient and the sender see *each other* as the peer, so the two views
  // must be built separately (the sender must never see themselves as peer).
  hub.sendToUser(targetId, {
    type: SERVER.FRIEND_REQUEST,
    request: { ...base, direction: 'incoming', peer: userRepo.toPublic(from) },
  });

  log.info(`request ${fromUserId} -> ${targetId} (id=${request.id})`);
  return {
    outcome: 'requested',
    request: { ...base, direction: 'outgoing', peer: userRepo.toPublic(target) },
  };
}

async function listRequests(userId) {
  return friendRepo.listRequests(userId, 'pending');
}

/** Accept / reject an incoming request, notifying both parties on accept. */
async function respond({ userId, requestId, action }) {
  const request = await friendRepo.findRequestById(requestId);
  if (!request) throw AppError.notFound('REQUEST_NOT_FOUND', '好友申请不存在');
  if (Number(request.to_user_id) !== Number(userId)) {
    throw AppError.forbidden('NOT_RECIPIENT', '无权处理该好友申请');
  }
  if (request.status !== 'pending') {
    throw AppError.conflict('REQUEST_CLOSED', '该申请已被处理');
  }

  const fromId = Number(request.from_user_id);
  const meId = Number(userId);

  if (action === 'reject') {
    await friendRepo.updateRequestStatus(requestId, 'rejected');
    return { ok: true, status: 'rejected' };
  }

  if (action !== 'accept') {
    throw AppError.badRequest('INVALID_ACTION', 'action 仅支持 accept / reject');
  }

  await assertFriendCapacity(meId);
  await friendRepo.insertPair(meId, fromId);
  await friendRepo.updateRequestStatus(requestId, 'accepted');

  const [me, peer] = await Promise.all([
    userRepo.findPublicById(meId),
    userRepo.findPublicById(fromId),
  ]);

  const payloadFor = (self, other) => ({
    type: SERVER.FRIEND_ACCEPTED,
    requestId: Number(requestId),
    friend: userRepo.toPublic(other),
    self: userRepo.toPublic(self),
  });

  hub.sendToUser(meId, payloadFor(me, peer));
  hub.sendToUser(fromId, payloadFor(peer, me));
  log.info(`friend accepted ${meId} <-> ${fromId}`);
  return { ok: true, status: 'accepted', friend: userRepo.toPublic(peer) };
}

async function listFriends(userId) {
  const friends = await friendRepo.listFriends(userId);
  // Presence lives in memory, so it is layered on here rather than in the repo.
  return presenceService.annotate(friends);
}

/**
 * One-way removal: drops only the caller's own friend row.
 *
 * The peer keeps their side, so they still see the caller and the thread stays
 * usable in both directions (see `assertCanChat`). Idempotent: removing someone
 * who is not in your list reports `removed: false` rather than erroring.
 */
async function removeFriend({ userId, friendId }) {
  const targetId = Number(friendId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw AppError.badRequest('INVALID_TARGET', '目标用户不存在');
  }
  if (targetId === Number(userId)) {
    throw AppError.badRequest('SELF_REQUEST', '不能删除自己');
  }

  const removed = await friendRepo.removeFriendship(userId, targetId);
  if (removed) {
    // Only the actor's views change — the peer's list is untouched, so they must
    // NOT be notified. Own tabs are notified to keep the list consistent.
    hub.sendToUser(userId, { type: SERVER.FRIEND_REMOVED, friendId: targetId });
    log.info(`friend removed (one-way) ${userId} -> ${targetId}`);
  }
  return { friendId: targetId, removed };
}

/**
 * Message gate. Symmetric on purpose: because removal is one-way, requiring the
 * sender's own row would leave the remover able to receive but unable to reply.
 * A block in either direction short-circuits with a neutral message.
 */
async function assertCanChat(a, b) {
  if (await blockRepo.hasAnyBlock(a, b)) {
    throw AppError.forbidden('BLOCKED', '消息已发送失败：对方拒收了你的消息');
  }
  const ok = await friendRepo.canChat(a, b);
  if (!ok) throw AppError.forbidden('NOT_FRIENDS', '还不是好友关系，无法发送消息');
}

/** Sets/clears a private remark for a friend. */
async function setRemark({ userId, friendId, remark }) {
  const targetId = Number(friendId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw AppError.badRequest('INVALID_TARGET', '目标用户不存在');
  }
  let cleaned = null;
  if (remark !== undefined && remark !== null && String(remark).trim() !== '') {
    cleaned = contentFilter
      .assertClean(String(remark).trim().slice(0, REMARK_MAX), '备注')
      .slice(0, REMARK_MAX);
  }
  const ok = await friendRepo.setRemark(userId, targetId, cleaned);
  if (!ok) throw AppError.notFound('NOT_FRIEND', '对方不在你的好友列表中');
  return { friendId: targetId, remark: cleaned };
}

// --- Blocks (拉黑) ---------------------------------------------------------
async function addBlock({ userId, targetId }) {
  const id = Number(targetId);
  if (!Number.isInteger(id) || id <= 0 || id === Number(userId)) {
    throw AppError.badRequest('INVALID_TARGET', '目标用户不存在');
  }
  const target = await userRepo.findPublicById(id);
  if (!target) throw AppError.notFound('USER_NOT_FOUND', '目标用户不存在');
  await blockRepo.add({ userId, blockedId: id });
  log.info(`block ${userId} -> ${id}`);
  return { userId: id, blocked: true };
}

async function removeBlock({ userId, targetId }) {
  const id = Number(targetId);
  const removed = await blockRepo.remove({ userId, blockedId: id });
  return { userId: id, removed };
}

async function listBlocks(userId) {
  return blockRepo.list(userId);
}

// --- Friend invite links (邀请链接) ----------------------------------------
async function createInvite(userId) {
  return inviteLinkRepo.create({ userId, ttlMs: INVITE_TTL_MS });
}

const listInvites = (userId) => inviteLinkRepo.listForUser(userId);

async function revokeInvite({ userId, token }) {
  const ok = await inviteLinkRepo.revoke({ userId, token });
  if (!ok) throw AppError.notFound('INVITE_NOT_FOUND', '邀请链接不存在');
  return { token, revoked: true };
}

/** Sends a request via an invite link (channel = 'invite'). */
async function sendRequestByInvite({ fromUserId, token, message }) {
  const link = await inviteLinkRepo.findActive(String(token || ''));
  if (!link) throw AppError.notFound('INVITE_INVALID', '邀请链接无效或已过期');
  return sendRequest({ fromUserId, toUserId: link.userId, message, channel: 'invite' });
}

module.exports = {
  search,
  sendRequest,
  sendRequestByInvite,
  listRequests,
  respond,
  listFriends,
  removeFriend,
  setRemark,
  addBlock,
  removeBlock,
  listBlocks,
  createInvite,
  listInvites,
  revokeInvite,
  assertCanChat,
  areFriends: friendRepo.areFriends,
};
