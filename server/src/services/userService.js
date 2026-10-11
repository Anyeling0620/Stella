'use strict';

const userRepo = require('../repositories/userRepo');
const friendRepo = require('../repositories/friendRepo');
const contentFilter = require('./contentFilter');
const hub = require('../ws/hub');
const { SERVER } = require('../ws/protocol');
const { AppError } = require('../utils/errors');
const { isValidAvatar, AVATAR_PRESETS } = require('../constants/avatars');
const { createLogger } = require('../utils/logger');

const log = createLogger('user');

const NICKNAME_MAX = 64;
const BIO_MAX = 140;

/** Trims, drops control characters, and enforces the nickname bounds. */
function normaliseNickname(value) {
  if (typeof value !== 'string') {
    throw AppError.badRequest('INVALID_NICKNAME', '昵称必须为字符串');
  }
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (cleaned.length === 0) throw AppError.badRequest('INVALID_NICKNAME', '昵称不能为空');
  if (cleaned.length > NICKNAME_MAX) {
    throw AppError.badRequest('INVALID_NICKNAME', `昵称不能超过 ${NICKNAME_MAX} 个字符`);
  }
  return contentFilter.assertClean(cleaned, '昵称');
}

/** Trims the bio; an empty string clears it back to null. */
function normaliseBio(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw AppError.badRequest('INVALID_BIO', '个性签名必须为字符串');
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, BIO_MAX);
  if (cleaned.length === 0) return null;
  return contentFilter.assertClean(cleaned, '个性签名');
}

/**
 * Updates the caller's own profile and refreshes every view of them.
 *
 * The fan-out matters: a friend list is a *snapshot* loaded when the shell
 * mounts, so without a push the peers keep rendering the old nickname/avatar
 * until a reload. Own tabs are notified too, for cross-tab consistency.
 */
async function updateProfile({ userId, nickname, avatar, bio }) {
  const hasNickname = nickname !== undefined;
  const hasAvatar = avatar !== undefined;
  const hasBio = bio !== undefined;

  if (!hasNickname && !hasAvatar && !hasBio) {
    throw AppError.badRequest('NOTHING_TO_UPDATE', '没有需要更新的字段');
  }

  const patch = {};
  if (hasNickname) patch.nickname = normaliseNickname(nickname);
  if (hasAvatar) {
    // `null` clears the avatar; anything else must be a known preset id.
    if (!isValidAvatar(avatar)) {
      throw AppError.badRequest('INVALID_AVATAR', `头像必须是预设值之一：${AVATAR_PRESETS.join(', ')}`);
    }
    patch.avatar = avatar;
  }
  if (hasBio) patch.bio = normaliseBio(bio);

  const updated = await userRepo.updateProfile(userId, patch);
  if (!updated) throw AppError.notFound('USER_NOT_FOUND', '用户不存在');

  const publicUser = userRepo.toPublic(updated);
  const frame = { type: SERVER.PROFILE_UPDATED, user: publicUser };

  hub.sendToUser(userId, frame);
  const friendIds = await friendRepo.listFriendIds(userId);
  for (const friendId of friendIds) {
    hub.sendToUser(friendId, frame);
  }

  log.info(
    `profile updated user=${userId} fields=${Object.keys(patch).join('+')} peersNotified=${friendIds.length}`
  );
  return { user: publicUser, peersNotified: friendIds.length };
}

module.exports = { updateProfile, normaliseNickname, normaliseBio, NICKNAME_MAX, BIO_MAX };
