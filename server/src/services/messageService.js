'use strict';

const messageRepo = require('../repositories/messageRepo');
const noticeRepo = require('../repositories/noticeRepo');
const groupRepo = require('../repositories/groupRepo');
const attachmentRepo = require('../repositories/attachmentRepo');
const conversationRepo = require('../repositories/conversationRepo');
const friendService = require('./friendService');
const groupService = require('./groupService');
const presenceService = require('./presenceService');
const accountGuard = require('./accountGuard');
const contentFilter = require('./contentFilter');
const pushService = require('./pushService');
const userRepo = require('../repositories/userRepo');
const hub = require('../ws/hub');
const config = require('../config');
const { createLimiter } = require('../middleware/rateLimit');
const { SERVER } = require('../ws/protocol');
const { AppError } = require('../utils/errors');
const { createLogger } = require('../utils/logger');

const log = createLogger('message');

const MAX_CONTENT = 2000;

/** 撤回 window (chapter 7): 2 minutes. */
const RECALL_WINDOW_MS = config.security.messageRecallMs;

/** Per-user send throttle shared by the HTTP and WebSocket paths (60/min). */
const sendLimiter = createLimiter({ name: 'message', windowMs: 60 * 1000, max: 60 });

function assertContent(content) {
  if (typeof content !== 'string') throw AppError.badRequest('EMPTY_CONTENT', '消息内容不能为空');
  const trimmed = content.replace(/\u0000/g, '').trim();
  if (trimmed.length === 0) throw AppError.badRequest('EMPTY_CONTENT', '消息内容不能为空');
  if (trimmed.length > MAX_CONTENT) {
    throw AppError.badRequest('CONTENT_TOO_LONG', `消息内容不能超过 ${MAX_CONTENT} 个字符`);
  }
  return contentFilter.assertClean(trimmed, '消息');
}

/**
 * Persists a chat message then fans it out.
 *
 * `groupId` present -> group path (routed by membership); otherwise the 1:1
 * path is byte-for-byte the previous behaviour (routed by from/to).
 */
async function send({ fromUserId, toUserId, groupId, content, clientMsgId, mentions, type, attachmentId, quoteId }) {
  // Moderation + anti-flood gate, applied to both the HTTP and WS send paths.
  await accountGuard.assertNotRestricted(fromUserId, '发送消息');
  const verdict = sendLimiter.check(fromUserId);
  if (!verdict.allowed) {
    throw new AppError(429, 'RATE_LIMITED', '发送过于频繁，请稍后再试', { retryAfterSec: verdict.retryAfterSec });
  }
  const quote = Number(quoteId) || null;
  if (groupId !== undefined && groupId !== null && groupId !== '') {
    return sendToGroup({ fromUserId, groupId, content, clientMsgId, mentions, type, attachmentId, quoteId: quote });
  }
  return sendDirect({ fromUserId, toUserId, content, clientMsgId, type, attachmentId, quoteId: quote });
}

/**
 * Resolves a message payload. With an `attachmentId`, the media type and a text
 * fallback are derived from the stored attachment (and the sender is checked to
 * own it); otherwise the content is a plain text body.
 */
async function resolveMedia({ fromUserId, attachmentId, content, allowForeignAttachment = false }) {
  const attId = Number(attachmentId) || 0;
  if (!attId) return { type: 'text', content: assertContent(content), attachmentId: null };

  const attachment = await attachmentRepo.findById(attId);
  if (!attachment) throw AppError.badRequest('ATTACHMENT_NOT_FOUND', '附件不存在');
  // Forwarding re-sends an attachment the original recipient legitimately had
  // access to, so ownership is not re-checked in that path.
  if (!allowForeignAttachment && Number(attachment.uploader_id) !== Number(fromUserId)) {
    throw AppError.forbidden('ATTACHMENT_FORBIDDEN', '无权发送该附件');
  }
  const kind = attachment.kind === 'image' ? 'image' : attachment.kind === 'voice' ? 'voice' : 'file';
  const fallback = kind === 'image' ? '[图片]' : kind === 'voice' ? '[语音]' : `[文件] ${attachment.original_name}`;
  return { type: kind, content: fallback.slice(0, MAX_CONTENT), attachmentId: Number(attachment.id) };
}

/**
 * 1:1 send: persisted then fanned out to every tab of both participants.
 * Delivery status is decided at write time based on recipient presence.
 */
async function sendDirect({ fromUserId, toUserId, content, clientMsgId, type, attachmentId, quoteId = null, allowForeignAttachment = false }) {
  const targetId = Number(toUserId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw AppError.badRequest('INVALID_TARGET', '接收人不存在');
  }
  if (targetId === Number(fromUserId)) {
    throw AppError.badRequest('SELF_MESSAGE', '不能给自己发送消息');
  }
  await friendService.assertCanChat(fromUserId, targetId);

  const payload = await resolveMedia({ fromUserId, attachmentId, content, allowForeignAttachment });
  const recipientOnline = hub.isOnline(targetId);
  const message = await messageRepo.insert({
    clientMsgId: clientMsgId || null,
    fromUserId,
    toUserId: targetId,
    type: payload.type,
    attachmentId: payload.attachmentId,
    quoteId,
    content: payload.content,
  });

  if (recipientOnline && message.status === messageRepo.STATUS.SENT) {
    await messageRepo.markDelivered([message.id]);
    message.status = messageRepo.STATUS.DELIVERED;
  }

  const frame = { type: SERVER.CHAT_MESSAGE, message };
  hub.sendToUser(fromUserId, frame);
  if (targetId !== Number(fromUserId)) hub.sendToUser(targetId, frame);

  // Offline recipient -> Web Push (only when no live socket, to avoid duplicates).
  if (!hub.isOnline(targetId) && pushService.isEnabled()) {
    void messageRepo.authorOf(fromUserId).then((author) => {
      pushService.notifyUser(targetId, {
        title: author ? author.nickname : '新消息',
        body: message.content,
        tag: `d:${fromUserId}`,
        conversationId: `d:${fromUserId}`,
      });
    });
  }

  log.debug(`msg ${message.id} ${fromUserId}->${targetId}`);
  return message;
}

/**
 * Group send: any member may post. Mentions are validated against the roster so
 * a client cannot "mention" a non-member (or inject arbitrary ids).
 */
async function sendToGroup({ fromUserId, groupId, content, clientMsgId, mentions, type, attachmentId, quoteId = null, allowForeignAttachment = false }) {
  const gid = Number(groupId);
  const { group } = await groupService.assertMember(gid, fromUserId);

  const memberIds = await groupRepo.listMemberIds(gid);
  const memberSet = new Set(memberIds.map(Number));
  const mentionIds = (Array.isArray(mentions) ? mentions : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0 && memberSet.has(n) && n !== Number(fromUserId));

  const payload = await resolveMedia({ fromUserId, attachmentId, content, allowForeignAttachment });
  const message = await messageRepo.insert({
    clientMsgId: clientMsgId || null,
    fromUserId,
    toUserId: 0,
    groupId: gid,
    type: payload.type,
    mentions: mentionIds,
    attachmentId: payload.attachmentId,
    quoteId,
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

  // Push offline members (chapter 10): wechat-style "群名: 发送者: 内容".
  if (pushService.isEnabled()) {
    for (const id of memberIds) {
      const mid = Number(id);
      if (mid === Number(fromUserId) || hub.isOnline(mid)) continue;
      void pushService.notifyUser(mid, {
        title: group.name,
        body: `${fromUser ? fromUser.nickname : '成员'}：${message.content}`,
        tag: `g:${gid}`,
        conversationId: `g:${gid}`,
      });
    }
  }

  log.debug(`group msg ${message.id} ${fromUserId}=>${group.id} (${memberIds.length})`);
  return message;
}

async function history({ userId, friendId, beforeId = 0, limit = 50 }) {
  const targetId = Number(friendId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw AppError.badRequest('INVALID_FRIEND', '会话对象不存在');
  }
  const [peer, settings] = await Promise.all([
    userRepo.findPublicById(targetId),
    conversationRepo.get({ userId, peerKind: 'direct', peerId: targetId }),
  ]);
  if (!peer) throw AppError.notFound('USER_NOT_FOUND', '对方用户不存在');
  const messages = await messageRepo.history({
    userId,
    friendId: targetId,
    beforeId: Number(beforeId) || 0,
    clearedBefore: settings.clearedBeforeId,
    limit: Number(limit) || 50,
  });
  return { peer: userRepo.toPublic(peer), messages, settings };
}

/** Group history mirrors the 1:1 shape: header data + a page of messages. */
async function groupHistory({ userId, groupId, beforeId = 0, limit = 50 }) {
  const gid = Number(groupId);
  const { group } = await groupService.assertMember(gid, userId);
  const settings = await conversationRepo.get({ userId, peerKind: 'group', peerId: gid });
  const [roster, messages] = await Promise.all([
    groupRepo.listMembers(gid),
    messageRepo.groupHistory({
      groupId: gid,
      userId,
      beforeId: Number(beforeId) || 0,
      clearedBefore: settings.clearedBeforeId,
      limit: Number(limit) || 50,
    }),
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
    settings,
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

/** True when `userId` may see / act on this message. */
async function visibleTo(userId, message) {
  const uid = Number(userId);
  if (message.groupId) {
    const ids = await groupRepo.listMemberIds(message.groupId);
    return ids.map(Number).includes(uid);
  }
  return message.fromUserId === uid || message.toUserId === uid;
}

/** Delivers a conversation-scoped frame to every participant. */
async function fanOut(message, frame) {
  if (message.groupId) {
    const ids = await groupRepo.listMemberIds(message.groupId);
    for (const id of ids) hub.sendToUser(id, frame);
    return;
  }
  hub.sendToUser(message.fromUserId, frame);
  hub.sendToUser(message.toUserId, frame);
}

/** 撤回: sender-only, within the recall window. */
async function recall({ userId, messageId }) {
  const id = Number(messageId);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('INVALID_MESSAGE', '消息不存在');
  const message = await messageRepo.findById(id);
  if (!message) throw AppError.notFound('MESSAGE_NOT_FOUND', '消息不存在');
  if (message.fromUserId !== Number(userId)) throw AppError.forbidden('NOT_AUTHOR', '只能撤回自己发送的消息');
  if (message.recalled) return { ok: true, message };

  const age = Date.now() - new Date(message.createdAt).getTime();
  if (age > RECALL_WINDOW_MS) throw AppError.badRequest('RECALL_EXPIRED', '超过 2 分钟的消息不能撤回');

  await messageRepo.recall(id, userId);
  const updated = await messageRepo.findById(id);
  const frame = {
    type: SERVER.CHAT_RECALLED,
    messageId: id,
    groupId: updated.groupId,
    fromUserId: updated.fromUserId,
    toUserId: updated.toUserId,
    message: updated,
  };
  await fanOut(updated, frame);
  log.debug(`recall ${id} by ${userId}`);
  return { ok: true, message: updated };
}

/** Local-only delete ("删除"): hides the message for the caller. */
async function deleteLocal({ userId, messageId }) {
  const id = Number(messageId);
  const message = await messageRepo.findById(id);
  if (!message) throw AppError.notFound('MESSAGE_NOT_FOUND', '消息不存在');
  if (!(await visibleTo(userId, message))) throw AppError.forbidden('FORBIDDEN', '无权操作该消息');
  await messageRepo.hideForUser(userId, id);
  return { ok: true, messageId: id };
}

/** Clear history: sets a per-user watermark so older rows stop loading. */
async function clearConversation({ userId, peerKind, peerId }) {
  const kind = peerKind === 'group' ? 'group' : 'direct';
  const pid = Number(peerId);
  if (!Number.isInteger(pid) || pid <= 0) throw AppError.badRequest('INVALID_TARGET', '会话不存在');
  if (kind === 'group') await groupService.assertMember(pid, userId);

  const beforeId = await messageRepo.maxIdInConversation({ userId, peerKind: kind, peerId: pid });
  const settings = await conversationRepo.setCleared({ userId, peerKind: kind, peerId: pid, clearedBeforeId: beforeId });
  return { ok: true, peerKind: kind, peerId: pid, settings };
}

/** Normalize an ISO date string to a UTC 'YYYY-MM-DD HH:mm:ss' bound (or null). */
const toUtcBound = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * In-conversation search (1:1 or group).
 *
 * Either a keyword, a date window, or both. An empty keyword with a date window
 * browses that window (all jumpable rows) — WeChat's 按日期.
 */
async function searchMessages({ userId, friendId, groupId, keyword, from, to }) {
  const kw = (keyword || '').toString().trim();
  const fromUtc = toUtcBound(from);
  const toUtc = toUtcBound(to);
  if (kw.length === 0 && !fromUtc && !toUtc) return [];
  if (fromUtc && toUtc && fromUtc >= toUtc) throw AppError.badRequest('INVALID_RANGE', '日期范围不正确');
  const gid = Number(groupId) || 0;
  if (gid) {
    await groupService.assertMember(gid, userId);
  } else {
    const fid = Number(friendId);
    if (!Number.isInteger(fid) || fid <= 0) throw AppError.badRequest('INVALID_FRIEND', '会话对象不存在');
  }
  return messageRepo.search({
    userId,
    friendId: Number(friendId) || 0,
    groupId: gid,
    keyword: kw.slice(0, 64),
    from: fromUtc,
    to: toUtc,
  });
}

/** 逐条转发 to friends and/or groups, preserving media + text. */
async function forward({ userId, messageId, targetUserIds = [], targetGroupIds = [] }) {
  const id = Number(messageId);
  const original = await messageRepo.findById(id);
  if (!original) throw AppError.notFound('MESSAGE_NOT_FOUND', '消息不存在');
  if (!(await visibleTo(userId, original))) throw AppError.forbidden('FORBIDDEN', '无权转发该消息');
  if (original.recalled) throw AppError.badRequest('RECALLED', '已撤回的消息不能转发');

  const users = (Array.isArray(targetUserIds) ? targetUserIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const groups = (Array.isArray(targetGroupIds) ? targetGroupIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (users.length === 0 && groups.length === 0) {
    throw AppError.badRequest('NO_TARGET', '请选择转发对象');
  }

  const sent = [];
  for (const tid of users) {
    sent.push(
      await sendDirect({
        fromUserId: userId,
        toUserId: tid,
        content: original.content,
        clientMsgId: `fwd-${id}-u${tid}-${Date.now()}-${sent.length}`,
        type: original.type,
        attachmentId: original.attachmentId,
        allowForeignAttachment: true,
      })
    );
  }
  for (const gid of groups) {
    sent.push(
      await sendToGroup({
        fromUserId: userId,
        groupId: gid,
        content: original.content,
        clientMsgId: `fwd-${id}-g${gid}-${Date.now()}-${sent.length}`,
        type: original.type,
        attachmentId: original.attachmentId,
        allowForeignAttachment: true,
      })
    );
  }
  return { forwarded: sent.length, messages: sent };
}

module.exports = {
  send,
  sendDirect,
  sendToGroup,
  history,
  groupHistory,
  poll,
  markRead,
  readGroup,
  recall,
  deleteLocal,
  clearConversation,
  searchMessages,
  forward,
  MAX_CONTENT,
  RECALL_WINDOW_MS,
};
