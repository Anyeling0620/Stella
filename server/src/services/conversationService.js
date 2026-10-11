'use strict';

const conversationRepo = require('../repositories/conversationRepo');
const messageService = require('./messageService');
const hub = require('../ws/hub');
const config = require('../config');
const { SERVER } = require('../ws/protocol');
const { AppError } = require('../utils/errors');

/** All of the caller's conversation settings (pin / mute), for list merges. */
const list = async (userId) => {
  const map = await conversationRepo.listForUser(userId);
  return [...map.entries()].map(([key, value]) => {
    const [peerKind, peerId] = key.split(':');
    return { peerKind, peerId: Number(peerId), ...value };
  });
};

/** Pin / mute a conversation, enforcing the pin cap. */
async function update({ userId, peerKind, peerId, pinned, muted }) {
  const kind = peerKind === 'group' ? 'group' : 'direct';
  const pid = Number(peerId);
  if (!Number.isInteger(pid) || pid <= 0) throw AppError.badRequest('INVALID_TARGET', '会话不存在');

  if (pinned === true) {
    const already = await conversationRepo.get({ userId, peerKind: kind, peerId: pid });
    if (!already.pinned) {
      const count = await conversationRepo.countPinned(userId);
      if (count >= config.security.maxPinnedConversations) {
        throw AppError.forbidden('PIN_LIMIT', `最多置顶 ${config.security.maxPinnedConversations} 个会话，请先取消其它置顶`);
      }
    }
  }

  const settings = await conversationRepo.setFlags({
    userId,
    peerKind: kind,
    peerId: pid,
    pinned: pinned === undefined ? undefined : Boolean(pinned),
    muted: muted === undefined ? undefined : Boolean(muted),
  });
  // Own tabs only — pin/mute are per-user.
  hub.sendToUser(userId, { type: SERVER.CONVERSATION_UPDATED, peerKind: kind, peerId: pid, settings });
  return { peerKind: kind, peerId: pid, settings };
}

module.exports = { list, update, clear: messageService.clearConversation };
