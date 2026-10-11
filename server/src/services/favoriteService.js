'use strict';

const favoriteRepo = require('../repositories/favoriteRepo');
const messageRepo = require('../repositories/messageRepo');
const { SERVER } = require('../ws/protocol');
const { AppError } = require('../utils/errors');
const hub = require('../ws/hub');

/**
 * 收藏 (chapter 11). The stored row is a snapshot of the message so that
 * recalling or deleting the original does not break the favourite.
 */
async function add({ userId, messageId, srcConversation = null }) {
  const id = Number(messageId);
  const message = await messageRepo.findById(id);
  if (!message) throw AppError.notFound('MESSAGE_NOT_FOUND', '消息不存在');
  const favorite = await favoriteRepo.create({
    userId,
    messageId: id,
    type: message.type,
    content: message.content,
    attachmentId: message.attachmentId,
    fromUserId: message.fromUserId,
    srcConversation,
  });
  hub.sendToUser(userId, { type: SERVER.FAVORITE_UPDATED, action: 'added', favoriteId: favorite.id });
  return favorite;
}

const list = (userId) => favoriteRepo.list(userId);

async function remove({ userId, id }) {
  const ok = await favoriteRepo.remove({ userId, id: Number(id) });
  if (ok) hub.sendToUser(userId, { type: SERVER.FAVORITE_UPDATED, action: 'removed', favoriteId: Number(id) });
  return { id: Number(id), removed: ok };
}

module.exports = { add, list, remove };
