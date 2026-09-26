'use strict';

const friendRepo = require('../repositories/friendRepo');
const userRepo = require('../repositories/userRepo');
const hub = require('../ws/hub');
const { SERVER } = require('../ws/protocol');
const { AppError } = require('../utils/errors');
const { createLogger } = require('../utils/logger');

const log = createLogger('friend');

async function search({ userId, keyword }) {
  const q = (keyword || '').toString().trim();
  if (q.length === 0) return [];
  return userRepo.search({ userId, keyword: q.slice(0, 32), limit: 20 });
}

/** Sends (or re-sends) a friend request and notifies the recipient over WS. */
async function sendRequest({ fromUserId, toUserId, message }) {
  const targetId = Number(toUserId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw AppError.badRequest('INVALID_TARGET', '目标用户不存在');
  }
  if (targetId === Number(fromUserId)) {
    throw AppError.badRequest('SELF_REQUEST', '不能添加自己为好友');
  }

  const target = await userRepo.findPublicById(targetId);
  if (!target) throw AppError.notFound('USER_NOT_FOUND', '目标用户不存在');

  if (await friendRepo.areFriends(fromUserId, targetId)) {
    throw AppError.conflict('ALREADY_FRIENDS', '你们已经是好友了');
  }

  // If the other side already requested us, accept instead of creating a
  // mirrored pending request. The caller must be able to tell the two outcomes
  // apart, so the result is discriminated (`outcome`).
  const inbound = await friendRepo.findRequestBetween(targetId, fromUserId);
  if (inbound && inbound.status === 'pending') {
    const accepted = await respond({ userId: fromUserId, requestId: inbound.id, action: 'accept' });
    return { outcome: 'auto-accepted', friend: accepted.friend };
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
  return friendRepo.listFriends(userId);
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
 */
async function assertCanChat(a, b) {
  const ok = await friendRepo.canChat(a, b);
  if (!ok) throw AppError.forbidden('NOT_FRIENDS', '还不是好友关系，无法发送消息');
}

module.exports = {
  search,
  sendRequest,
  listRequests,
  respond,
  listFriends,
  removeFriend,
  assertCanChat,
  areFriends: friendRepo.areFriends,
};
