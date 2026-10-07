'use strict';

const messageRepo = require('../repositories/messageRepo');
const noticeRepo = require('../repositories/noticeRepo');
const groupRepo = require('../repositories/groupRepo');
const attachmentRepo = require('../repositories/attachmentRepo');
const friendService = require('./friendService');
const groupService = require('./groupService');
const presenceService = require('./presenceService');
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
 * Persists a chat message then fans it out.
 *
 * `groupId` present -> group path (routed by membership); otherwise the 1:1
 * path is byte-for-byte the previous behaviour (routed by from/to).
 */
async function send({ fromUserId, toUserId, groupId, content, clientMsgId, mentions, type, attachmentId }) {
  if (groupId !== undefined && groupId !== null && groupId !== '') {
    return sendToGroup({ fromUserId, groupId, content, clientMsgId, mentions, type, attachmentId });
  }
  return sendDirect({ fromUserId, toUserId, content, clientMsgId, type, attachmentId });
}

/**
 * Resolves a message payload. With an `attachmentId`, the media type and a text
 * fallback are derived from the stored attachment (and the sender is checked to
 * own it); otherwise the content is a plain text body.
 */
async function resolveMedia({ fromUserId, attachmentId, content }) {
  const attId = Number(attachmentId) || 0;
  if (!attId) return { type: 'text', content: assertContent(content), attachmentId: null };

  const attachment = await attachmentRepo.findById(attId);
  if (!attachment) throw AppError.badRequest('ATTACHMENT_NOT_FOUND', '附件不存在');
  if (Number(attachment.uploader_id) !== Number(fromUserId)) {
    throw AppError.forbidden('ATTACHMENT_FORBIDDEN', '无权发送该附件');
  }
  const kind = attachment.kind === 'image' ? 'image' : 'file';
  const fallback = kind === 'image' ? '[图片]' : `[文件] ${attachment.original_name}`;
  return { type: kind, content: fallback.slice(0, MAX_CONTENT), attachmentId: Number(attachment.id) };
}

/**
 * 1:1 send: persisted then fanned out to every tab of both participants.
 * Delivery status is decided at write time based on recipient presence.
 */
async function sendDirect({ fromUserId, toUserId, content, clientMsgId, type, attachmentId }) {
  const targetId = Number(toUserId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw AppError.badRequest('INVALID_TARGET', '接收人不存在');
  }
  if (targetId === Number(fromUserId)) {
    throw AppError.badRequest('SELF_MESSAGE', '不能给自己发送消息');
  }
  await friendService.assertCanChat(fromUserId, targetId);

  const payload = await resolveMedia({ fromUserId, attachmentId, content });
  const recipientOnline = hub.isOnline(targetId);
  const message = await messageRepo.insert({
    clientMsgId: clientMsgId || null,
    fromUserId,
    toUserId: targetId,
    type: payload.type,
    attachmentId: payload.attachmentId,
    content: payload.content,
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

/**
 * Group send: any member may post. Mentions are validated against the roster so
 * a client cannot "mention" a non-member (or inject arbitrary ids).
 */
async function sendToGroup({ fromUserId, groupId, content, clientMsgId, mentions, type, attachmentId }) {
  const gid = Number(groupId);
  const { group } = await groupService.assertMember(gid, fromUserId);

  const memberIds = await groupRepo.listMemberIds(gid);
  const memberSet = new Set(memberIds.map(Number));
  const mentionIds = (Array.isArray(mentions) ? mentions : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && memberSet.has(n) && n !== Number(fromUserId));

  const payload = await resolveMedia({ fromUserId, attachmentId, content });
  const message = await messageRepo.insert({
    clientMsgId: clientMsgId || null,
    fromUserId,
    toUserId: 0,
    groupId: gid,
    type: payload.type,
    mentions: mentionIds,
    attachmentId: payload.attachmentId,
    content: payload.content,
  });

  const anyRecipientOnline = memberIds.some(
    (id) => Number(id) !== Number(fromUserId) && hub.isOnline(id)
  );
  if (anyRecipientOnline && message.status === messageRepo.STATUS.SENT) {
    await messageRepo.markDelivered([message.id]);
    message.status = messageRepo.STATUS.DELIVERED;
  }

  const fromUser = await messageRepo.authorOf(fromUserId);
  const frame = { type: SERVER.CHAT_MESSAGE, message: { ...message, fromUser } };
  for (const id of memberIds) hub.sendToUser(id, frame);

  log.debug(`group msg ${message.id} ${fromUserId}=>${group.id} (${memberIds.length})`);
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

/** Group history mirrors the 1:1 shape: header data + a page of messages. */
async function groupHistory({ userId, groupId, beforeId = 0, limit = 50 }) {
  const gid = Number(groupId);
  const { group } = await groupService.assertMember(gid, userId);
  const [roster, messages] = await Promise.all([
    groupRepo.listMembers(gid),
    messageRepo.groupHistory({ groupId: gid, beforeId: Number(beforeId) || 0, limit: Number(limit) || 50 }),
  ]);
  // Annotate presence so the thread header can show "N 人在线" from first paint.
  const members = presenceService.annotate(roster);
  return {
    group: {
      ...groupRepo.toDTO(group),
      memberCount: members.length,
      onlineCount: presenceService.countOnline(members),
    },
    members,
    messages,
  };
}

/** Incremental cursor sync used by the polling fallback (and WS resume). */
async function poll({ userId, sinceId = 0, noticeSinceId = 0, limit = 100 }) {
  const [messages, notices] = await Promise.all([
    messageRepo.incremental({ userId, sinceId: Number(sinceId) || 0, limit: Number(limit) || 100 }),
    noticeRepo.listSince({ sinceId: Number(noticeSinceId) || 0, limit: 50 }),
  ]);
  return { messages, notices, serverTime: new Date().toISOString() };
}

/**
 * Read receipts.
 *
 * 1:1 rows are marked read and their authors notified (unchanged); group rows
 * simply advance the reader's per-group cursor — no per-message fan-out, which
 * matches QQ/微信 where group messages have no "已读" state.
 */
async function markRead({ userId, ids }) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (list.length === 0) return { ok: true, updated: 0 };

  const rows = await messageRepo.receivedUnread(userId, list);
  if (rows.length === 0) return { ok: true, updated: 0 };

  const directIds = [];
  const idsByAuthor = new Map();
  const groupMax = new Map();

  for (const row of rows) {
    if (row.group_id) {
      const gid = Number(row.group_id);
      groupMax.set(gid, Math.max(groupMax.get(gid) ?? 0, Number(row.id)));
    } else {
      const id = Number(row.id);
      directIds.push(id);
      const author = Number(row.from_user_id);
      if (!idsByAuthor.has(author)) idsByAuthor.set(author, []);
      idsByAuthor.get(author).push(id);
    }
  }

  if (directIds.length > 0) {
    await messageRepo.markRead(directIds);
    for (const [author, readIds] of idsByAuthor) {
      hub.sendToUser(author, { type: SERVER.CHAT_STATUS, status: 2, ids: readIds, readerId: Number(userId) });
    }
  }

  for (const [gid, lastId] of groupMax) {
    await groupRepo.touchLastRead(gid, userId, lastId);
  }

  return { ok: true, updated: rows.length };
}

/** Explicitly advances the read cursor of one group (group window batch flush). */
async function readGroup({ userId, groupId, lastMessageId }) {
  const gid = Number(groupId);
  await groupService.assertMember(gid, userId);
  const last = Number(lastMessageId) || 0;
  if (last > 0) await groupRepo.touchLastRead(gid, userId, last);
  return { ok: true, lastMessageId: last };
}

module.exports = { send, sendDirect, sendToGroup, history, groupHistory, poll, markRead, readGroup, MAX_CONTENT };
