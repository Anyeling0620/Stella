'use strict';

const userRepo = require('../repositories/userRepo');
const { AppError } = require('../utils/errors');

/**
 * Moderation gate (chapter 14 "违规处置"). A user row may carry `banned` or a
 * `muted_until` timestamp; restricted users can still read but cannot perform
 * the guarded write actions. The refusal always states the reason + deadline so
 * the client can show an appeal hint.
 *
 * `action` is a human label ("发送消息", "添加好友", "创建群聊").
 */
async function assertNotRestricted(userId, action = '执行该操作') {
  const user = await userRepo.findById(userId);
  if (!user || user.deleted_at) throw AppError.unauthorized('ACCOUNT_DELETED', '账号不可用');
  if (user.banned) {
    throw AppError.forbidden('ACCOUNT_BANNED', `账号已被限制，无法${action}，如有疑问可提交申诉`);
  }
  if (user.muted_until && new Date(user.muted_until).getTime() > Date.now()) {
    const until = new Date(user.muted_until);
    throw AppError.forbidden('MUTED', `你已被禁言至 ${until.toISOString()}，期间无法${action}`);
  }
  return user;
}

module.exports = { assertNotRestricted };
