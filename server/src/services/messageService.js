'use strict';

const messageRepo = require('../repositories/messageRepo');
const noticeRepo = require('../repositories/noticeRepo');
const friendService = require('./friendService');
const userRepo = require('../repositories/userRepo');
const hub = require('../ws/hub');
const { SERVER } = require('../ws/protocol');
const { AppError } = require('../utils/errors');
const { createLogger } = require('../utils/logger');

const log = createLogger('message');

const MAX_CONTENT = 2000;

function assertContent(content) {
  if (typeof content !== 'string') throw AppError.badRequest('EMPTY_CONTENT', '消息内容不能为空');
  const trimmed = content.replace(/\u0000/g, '').trim();
  if (trimmed.length === 0) throw AppError.badRequest('EMPTY_CONTENT', '消息内容不能为空');
  if (trimmed.length > MAX_CONTENT) {
    throw AppError.badRequest('CONTENT_TOO_LONG', `消息内容不能超过 ${MAX_CONTENT} 个字符`);
  }
  return trimmed;
}

/**
 * Persists a chat message then fans it out to every tab of both participants.
 * Delivery status is decided at write time based on recipient presence.
 */
async function send({ fromUserId, toUserId, content, clientMsgId }) {
  const text = assertContent(content);
  const targetId = Number(toUserId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw AppError.badRequest('INVALID_TARGET', '接收人不存在');
  }
  if (targetId === Number(fromUserId)) {
    throw AppError.badRequest('SELF_MESSAGE', '不能给自己发送消息');
  }
  await friendService.assertCanChat(fromUserId, targetId);

  const recipientOnline = hub.isOnline(targetId);
  const message = await messageRepo.insert({
    clientMsgId: clientMsgId || null,
    fromUserId,
    toUserId: targetId,
    content: text,
  });

  if (recipientOnline && message.status === messageRepo.STATUS.SENT) {
    await messageRepo.markDelivered([message.id]);
    message.status = messageRepo.STATUS.DELIVERED;
  }

  const frame = { type: SERVER.CHAT_MESSAGE, message };
  hub.sendToUser(fromUserId, frame);
  if (targetId !== Number(fromUserId)) hub.sendToUser(targetId, frame);

  log.debug(`msg ${message.id} ${fromUserId}->${targetId}`);
  return message;
}

async function history({ userId, friendId, beforeId = 0, limit = 50 }) {
  const targetId = Number(friendId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw AppError.badRequest('INVALID_FRIEND', '会话对象不存在');
  }
  const [peer, messages] = await Promise.all([
    userRepo.findPublicById(targetId),
    messageRepo.history({ userId, friendId: targetId, beforeId: Number(beforeId) || 0, limit: Number(limit) || 50 }),
  ]);
  if (!peer) throw AppError.notFound('USER_NOT_FOUND', '对方用户不存在');
  return { peer: userRepo.toPublic(peer), messages };
}

/** Incremental cursor sync used by the polling fallback (and WS resume). */
async function poll({ userId, sinceId = 0, noticeSinceId = 0, limit = 100 }) {
  const [messages, notices] = await Promise.all([
    messageRepo.incremental({ userId, sinceId: Number(sinceId) || 0, limit: Number(limit) || 100 }),
    noticeRepo.listSince({ sinceId: Number(noticeSinceId) || 0, limit: 50 }),
  ]);
  return { messages, notices, serverTime: new Date().toISOString() };
}

/** Read receipts: marks received messages as read and notifies the authors. */
async function markRead({ userId, ids }) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (list.length === 0) return { ok: true, updated: 0 };

  const rows = await messageRepo.pendingReceived(userId, list);
  if (rows.length === 0) return { ok: true, updated: 0 };

  const idsByAuthor = new Map();
  for (const row of rows) {
    const author = Number(row.from_user_id);
    if (!idsByAuthor.has(author)) idsByAuthor.set(author, []);
    idsByAuthor.get(author).push(Number(row.id));
  }

  const updatedIds = rows.map((r) => Number(r.id));
  await messageRepo.markRead(updatedIds);

  for (const [author, readIds] of idsByAuthor) {
    hub.sendToUser(author, { type: SERVER.CHAT_STATUS, status: 2, ids: readIds, readerId: Number(userId) });
  }
  return { ok: true, updated: updatedIds.length };
}

module.exports = { send, history, poll, markRead, MAX_CONTENT };
