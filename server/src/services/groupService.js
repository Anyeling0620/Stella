'use strict';

const groupRepo = require('../repositories/groupRepo');
const userRepo = require('../repositories/userRepo');
const friendRepo = require('../repositories/friendRepo');
const messageRepo = require('../repositories/messageRepo');
const hub = require('../ws/hub');
const { SERVER } = require('../ws/protocol');
const { isValidAvatar } = require('../constants/avatars');
const { AppError } = require('../utils/errors');
const { createLogger } = require('../utils/logger');

const log = createLogger('group');

const MAX_NAME = 64;
const MAX_ANNOUNCEMENT = 500;

function normaliseName(name) {
  const value = typeof name === 'string' ? name.replace(/\u0000/g, '').trim() : '';
  if (value.length === 0) throw AppError.badRequest('INVALID_GROUP_NAME', '群名称不能为空');
  if (value.length > MAX_NAME) {
    throw AppError.badRequest('INVALID_GROUP_NAME', `群名称不能超过 ${MAX_NAME} 个字符`);
  }
  return value;
}

function normaliseAnnouncement(value) {
  if (value === null) return null;
  const text = typeof value === 'string' ? value.replace(/\u0000/g, '').trim() : '';
  if (text.length > MAX_ANNOUNCEMENT) {
    throw AppError.badRequest('INVALID_ANNOUNCEMENT', `群公告不能超过 ${MAX_ANNOUNCEMENT} 个字符`);
  }
  return text.length === 0 ? null : text;
}

const normaliseIdList = (value) =>
  [...new Set((Array.isArray(value) ? value : []).map(Number))].filter(
    (n) => Number.isInteger(n) && n > 0
  );

/** 6-digit, collision-checked shareable group number (QQ-style 群号). */
async function generateGroupNo() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const no = Math.floor(100000 + Math.random() * 900000);
    if (!(await groupRepo.findByGroupNo(no))) return no;
  }
  return Math.floor(100000000 + Math.random() * 900000000);
}

/**
 * Resolves a group the caller is a member of, or throws.
 * Returns the raw group row plus the caller's membership row.
 */
async function assertMember(groupId, userId) {
  const gid = Number(groupId);
  if (!Number.isInteger(gid) || gid <= 0) {
    throw AppError.badRequest('INVALID_GROUP', '群聊不存在');
  }
  const group = await groupRepo.findById(gid);
  if (!group) throw AppError.notFound('GROUP_NOT_FOUND', '群聊不存在');
  const membership = await groupRepo.membershipOf(gid, userId);
  if (!membership) throw AppError.forbidden('NOT_GROUP_MEMBER', '你不在该群聊中');
  return { group, membership };
}

async function assertOwner(group, userId) {
  if (Number(group.owner_id) !== Number(userId)) {
    throw AppError.forbidden('NOT_GROUP_OWNER', '只有群主可以执行该操作');
  }
}

/** Persists and fans out an in-thread system notice. */
async function postSystemMessage(groupId, content, memberIds) {
  const ids = memberIds || (await groupRepo.listMemberIds(groupId));
  const message = await messageRepo.insert({
    fromUserId: 0,
    toUserId: 0,
    groupId,
    type: 'system',
    content,
  });
  const frame = { type: SERVER.CHAT_MESSAGE, message };
  for (const id of ids) hub.sendToUser(id, frame);
  return message;
}

const broadcast = (memberIds, frame) => {
  for (const id of memberIds) hub.sendToUser(id, frame);
};

/**
 * Adds members and fans out the roster change + a system notice.
 * Shared by the friend-add path and the join-approval path (which admits
 * non-friends, so this deliberately does NOT re-check friendship).
 */
async function admitMembers(groupId, memberIds, names) {
  if (memberIds.length === 0) return;
  await groupRepo.addMembers(groupId, memberIds);
  const allMembers = await groupRepo.listMemberIds(groupId);
  const members = await groupRepo.listMembers(groupId);
  broadcast(allMembers, { type: SERVER.GROUP_MEMBER_ADDED, groupId, members });
  await postSystemMessage(groupId, `${names.join('、')} 加入了群聊`, allMembers);
}

/** Group payload used by lifecycle pushes: base row + member count + members. */
async function groupPayload(groupId) {
  const [group, members] = await Promise.all([groupRepo.findById(groupId), groupRepo.listMembers(groupId)]);
  return { ...groupRepo.toDTO(group), memberCount: members.length, members };
}

async function createGroup({ ownerId, name, memberIds }) {
  const groupName = normaliseName(name);
  const candidates = normaliseIdList(memberIds).filter((id) => id !== Number(ownerId));

  // WeChat-style direct add: only friends of the creator may be pulled in.
  const admitted = [];
  for (const id of candidates) {
    const target = await userRepo.findPublicById(id);
    if (!target) continue;
    if (await friendRepo.canChat(ownerId, id)) admitted.push(id);
  }

  const group = await groupRepo.createGroup({ name: groupName, ownerId, groupNo: await generateGroupNo() });
  const gid = Number(group.id);
  if (admitted.length > 0) await groupRepo.addMembers(gid, admitted);

  const allMembers = [Number(ownerId), ...admitted];
  const payload = await groupPayload(gid);
  broadcast(allMembers, { type: SERVER.GROUP_CREATED, group: payload });
  await postSystemMessage(gid, `群聊「${groupName}」创建成功`, allMembers);

  log.info(`group ${gid} created by ${ownerId} (+${admitted.length})`);
  return payload;
}

function list(userId) {
  return groupRepo.listForUser(userId);
}

async function detail({ userId, groupId }) {
  const { group } = await assertMember(groupId, userId);
  const members = await groupRepo.listMembers(Number(groupId));
  return { group: groupRepo.toDTO(group), members };
}

async function update({ userId, groupId, patch = {} }) {
  const gid = Number(groupId);
  const { group } = await assertMember(gid, userId);
  await assertOwner(group, userId);

  const next = {};
  if (patch.name !== undefined) next.name = normaliseName(patch.name);
  if (patch.avatar !== undefined) {
    if (!isValidAvatar(patch.avatar)) throw AppError.badRequest('INVALID_AVATAR', '群头像不合法');
    next.avatar = patch.avatar;
  }
  if (patch.announcement !== undefined) next.announcement = normaliseAnnouncement(patch.announcement);
  if (Object.keys(next).length === 0) {
    throw AppError.badRequest('NOTHING_TO_UPDATE', '没有需要更新的字段');
  }

  const updated = await groupRepo.updateGroup(gid, next);
  const memberIds = await groupRepo.listMemberIds(gid);
  broadcast(memberIds, { type: SERVER.GROUP_UPDATED, group: groupRepo.toDTO(updated) });
  if (next.name !== undefined) {
    await postSystemMessage(gid, `群名称已改为「${next.name}」`, memberIds);
  }
  return groupRepo.toDTO(updated);
}

async function addMembers({ userId, groupId, userIds }) {
  const gid = Number(groupId);
  const { group } = await assertMember(gid, userId);
  await assertOwner(group, userId);

  const candidates = normaliseIdList(userIds).filter((id) => id !== Number(userId));
  const admitted = [];
  const names = [];
  for (const id of candidates) {
    const target = await userRepo.findPublicById(id);
    if (!target) continue;
    if (!(await friendRepo.canChat(userId, id))) continue;
    if (await groupRepo.isMember(gid, id)) continue;
    admitted.push(id);
    names.push(target.nickname);
  }

  if (admitted.length === 0) return { groupId: gid, added: [] };

  await admitMembers(gid, admitted, names);
  return { groupId: gid, added: admitted };
}

/** Group discovery by 群号 (exact) or name substring; excludes groups I'm in. */
function search({ userId, keyword }) {
  const q = (keyword || '').toString().trim().slice(0, 32);
  if (q.length === 0) return Promise.resolve([]);
  return groupRepo.searchGroups({ userId, keyword: q });
}

/** Apply to join a group by id (QQ-style). Notifies the owner. */
async function requestJoin({ userId, groupId, message }) {
  const gid = Number(groupId);
  if (!Number.isInteger(gid) || gid <= 0) throw AppError.badRequest('INVALID_GROUP', '群聊不存在');
  const group = await groupRepo.findById(gid);
  if (!group) throw AppError.notFound('GROUP_NOT_FOUND', '群聊不存在');
  if (await groupRepo.isMember(gid, userId)) {
    throw AppError.conflict('ALREADY_GROUP_MEMBER', '你已经在该群聊中');
  }

  const note = (message || '').toString().trim().slice(0, 255) || null;
  const request = await groupRepo.upsertJoinRequest({ groupId: gid, userId, message: note });
  const applicant = await userRepo.findPublicById(userId);

  hub.sendToUser(Number(group.owner_id), {
    type: SERVER.GROUP_JOIN_REQUESTED,
    groupId: gid,
    groupName: group.name,
    request: {
      id: Number(request.id),
      groupId: gid,
      status: request.status,
      message: request.message,
      createdAt: request.created_at,
      applicant: userRepo.toPublic(applicant),
    },
  });

  log.info(`join request ${userId} -> group ${gid}`);
  return {
    id: Number(request.id),
    groupId: gid,
    status: request.status,
    message: request.message,
    createdAt: request.created_at,
  };
}

/** Pending join requests for a group (owner only). */
async function listJoinRequests({ userId, groupId }) {
  const gid = Number(groupId);
  const { group } = await assertMember(gid, userId);
  await assertOwner(group, userId);
  return groupRepo.listJoinRequests(gid, 'pending');
}

/** Approve / reject a join request (owner only). Approving admits the applicant. */
async function respondJoin({ userId, groupId, requestId, action }) {
  const gid = Number(groupId);
  const { group } = await assertMember(gid, userId);
  await assertOwner(group, userId);
  if (action !== 'approve' && action !== 'reject') {
    throw AppError.badRequest('INVALID_ACTION', 'action 仅支持 approve / reject');
  }

  const request = await groupRepo.findJoinRequestById(requestId);
  if (!request || Number(request.group_id) !== gid) {
    throw AppError.notFound('REQUEST_NOT_FOUND', '加群申请不存在');
  }
  if (request.status !== 'pending') {
    throw AppError.conflict('REQUEST_CLOSED', '该申请已被处理');
  }

  const applicantId = Number(request.user_id);

  if (action === 'reject') {
    await groupRepo.updateJoinRequestStatus(requestId, 'rejected');
    hub.sendToUser(applicantId, {
      type: SERVER.GROUP_JOIN_RESULT,
      groupId: gid,
      groupName: group.name,
      status: 'rejected',
    });
    return { ok: true, status: 'rejected' };
  }

  await groupRepo.updateJoinRequestStatus(requestId, 'approved');
  const applicant = await userRepo.findPublicById(applicantId);
  await admitMembers(gid, [applicantId], [applicant ? applicant.nickname : '新成员']);
  hub.sendToUser(applicantId, {
    type: SERVER.GROUP_JOIN_RESULT,
    groupId: gid,
    groupName: group.name,
    status: 'approved',
    group: await groupPayload(gid),
  });
  return { ok: true, status: 'approved' };
}

async function removeMember({ userId, groupId, memberId }) {
  const gid = Number(groupId);
  const { group } = await assertMember(gid, userId);
  await assertOwner(group, userId);

  const targetId = Number(memberId);
  if (targetId === Number(userId)) {
    throw AppError.badRequest('CANNOT_REMOVE_SELF', '群主不能移除自己，请使用解散群聊');
  }
  if (!(await groupRepo.isMember(gid, targetId))) {
    throw AppError.notFound('NOT_GROUP_MEMBER', '该成员不在群聊中');
  }
  const target = await userRepo.findPublicById(targetId);

  await groupRepo.removeMember(gid, targetId);
  const memberIds = await groupRepo.listMemberIds(gid);
  const members = await groupRepo.listMembers(gid);
  const frame = { type: SERVER.GROUP_MEMBER_REMOVED, groupId: gid, members, removedUserId: targetId };
  // The removed user is told explicitly (so their UI drops the group)…
  hub.sendToUser(targetId, frame);
  // …and the remaining members refresh their roster.
  broadcast(memberIds, frame);
  await postSystemMessage(gid, `${target ? target.nickname : '成员'} 被移出群聊`, memberIds);
  return { groupId: gid, removedUserId: targetId };
}

async function dissolve({ userId, groupId }) {
  const gid = Number(groupId);
  const { group } = await assertMember(gid, userId);
  await assertOwner(group, userId);

  const memberIds = await groupRepo.listMemberIds(gid);
  await groupRepo.dissolve(gid);
  broadcast(memberIds, { type: SERVER.GROUP_DISSOLVED, groupId: gid });
  log.info(`group ${gid} dissolved by ${userId}`);
  return { groupId: gid, dissolved: true };
}

/** Member leaves voluntarily. The owner leaving dissolves the group. */
async function leave({ userId, groupId }) {
  const gid = Number(groupId);
  const { group } = await assertMember(gid, userId);
  if (Number(group.owner_id) === Number(userId)) {
    return dissolve({ userId, groupId: gid });
  }

  const me = await userRepo.findPublicById(userId);
  await groupRepo.removeMember(gid, userId);
  const memberIds = await groupRepo.listMemberIds(gid);
  const members = await groupRepo.listMembers(gid);
  const frame = { type: SERVER.GROUP_MEMBER_LEFT, groupId: gid, userId: Number(userId), members };
  hub.sendToUser(userId, frame);
  broadcast(memberIds, frame);
  await postSystemMessage(gid, `${me ? me.nickname : '成员'} 退出了群聊`, memberIds);
  return { groupId: gid, left: true };
}

module.exports = {
  MAX_NAME,
  MAX_ANNOUNCEMENT,
  assertMember,
  createGroup,
  list,
  detail,
  update,
  addMembers,
  removeMember,
  dissolve,
  leave,
  search,
  requestJoin,
  listJoinRequests,
  respondJoin,
  postSystemMessage,
};
