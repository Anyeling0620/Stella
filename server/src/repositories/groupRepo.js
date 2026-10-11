'use strict';

const { query, transaction } = require('../db/pool');
const { toPublic } = require('./userRepo');

/**
 * Group metadata + membership persistence.
 *
 * Group messages live in the shared `messages` table (see messageRepo) keyed by
 * `group_id`; this module only owns the group row, its members, and each
 * member's read cursor.
 */

const toDTO = (row) => {
  if (!row) return null;
  return {
    id: Number(row.id),
    groupNo: row.group_no ? Number(row.group_no) : null,
    name: row.name,
    avatar: row.avatar || null,
    ownerId: Number(row.owner_id),
    announcement: row.announcement || null,
    joinApproval: Boolean(row.join_approval),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const memberDTO = (row) => ({
  id: Number(row.id),
  username: row.username,
  nickname: row.group_nickname || row.nickname,
  globalNickname: row.nickname,
  groupNickname: row.group_nickname || null,
  avatar: row.avatar || null,
  role: row.role,
  joinedAt: row.joined_at,
});

/** Group row inside a transaction (no DTO) — used right after insert. */
const findById = (id) =>
  query('SELECT * FROM `groups` WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);

const findByGroupNo = (groupNo) =>
  query('SELECT * FROM `groups` WHERE group_no = ? LIMIT 1', [groupNo]).then((r) => r[0] || null);

const createGroup = ({ name, avatar = null, ownerId, groupNo = null }) =>
  transaction(async (tx) => {
    const inserted = await tx.query(
      'INSERT INTO `groups` (group_no, name, avatar, owner_id) VALUES (?, ?, ?, ?)',
      [groupNo, name, avatar, ownerId]
    );
    const groupId = inserted.insertId;
    await tx.query(
      "INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')",
      [groupId, ownerId]
    );
    const rows = await tx.query('SELECT * FROM `groups` WHERE id = ? LIMIT 1', [groupId]);
    return rows[0] || null;
  });

/**
 * Group discovery (QQ-style): match an exact 群号 or a name substring, excluding
 * groups the caller already belongs to. `requestStatus` tells the UI whether a
 * join application is already pending.
 */
const searchGroups = async ({ userId, keyword, limit = 20 }) => {
  const numeric = /^\d+$/.test(keyword) ? Number(keyword) : 0;
  const like = `%${keyword}%`;
  const rows = await query(
    `SELECT g.*,
            (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
            (SELECT jr.status FROM group_join_requests jr
               WHERE jr.group_id = g.id AND jr.user_id = ?
               ORDER BY jr.id DESC LIMIT 1) AS my_request_status
       FROM \`groups\` g
      WHERE (g.group_no = ? OR g.name LIKE ?)
        AND g.id NOT IN (SELECT group_id FROM group_members WHERE user_id = ?)
      ORDER BY (g.group_no = ?) DESC, g.updated_at DESC
      LIMIT ?`,
    [userId, numeric, like, userId, numeric, Math.min(limit, 50)]
  );
  return rows.map((row) => ({
    ...toDTO(row),
    memberCount: Number(row.member_count) || 0,
    requestStatus: row.my_request_status || null,
  }));
};

/** Partial update: only the keys present are written. */
const updateGroup = async (id, patch) => {
  const assignments = [];
  const params = [];
  if (patch.name !== undefined) {
    assignments.push('name = ?');
    params.push(patch.name);
  }
  if (patch.avatar !== undefined) {
    assignments.push('avatar = ?');
    params.push(patch.avatar);
  }
  if (patch.announcement !== undefined) {
    assignments.push('announcement = ?');
    params.push(patch.announcement);
  }
  if (patch.joinApproval !== undefined) {
    assignments.push('join_approval = ?');
    params.push(patch.joinApproval ? 1 : 0);
  }
  if (assignments.length === 0) return findById(id);
  params.push(id);
  await query(`UPDATE \`groups\` SET ${assignments.join(', ')} WHERE id = ?`, params);
  return findById(id);
};

/** Dissolve: drops the group and every membership row. Messages are retained. */
const dissolve = (id) =>
  transaction(async (tx) => {
    await tx.query('DELETE FROM group_members WHERE group_id = ?', [id]);
    await tx.query('DELETE FROM `groups` WHERE id = ?', [id]);
  });

const listMemberIds = (groupId) =>
  query('SELECT user_id FROM group_members WHERE group_id = ?', [groupId]).then((rows) =>
    rows.map((r) => Number(r.user_id))
  );

const listMembers = (groupId) =>
  query(
    `SELECT u.id, u.username, u.nickname, u.avatar, gm.role, gm.joined_at, gm.nickname AS group_nickname
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ?
      ORDER BY (gm.role = 'owner') DESC, (gm.role = 'admin') DESC, gm.joined_at ASC`,
    [groupId]
  ).then((rows) => rows.map(memberDTO));

const membershipOf = (groupId, userId) =>
  query('SELECT * FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [
    groupId,
    userId,
  ]).then((r) => r[0] || null);

const isMember = (groupId, userId) =>
  query('SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ? LIMIT 1', [
    groupId,
    userId,
  ]).then((r) => r.length > 0);

/** Bulk insert, ignoring anyone already in the group. */
const addMembers = async (groupId, userIds) => {
  if (userIds.length === 0) return [];
  const placeholders = userIds.map(() => '(?, ?, \'member\')').join(', ');
  const params = [];
  for (const userId of userIds) params.push(groupId, userId);
  await query(
    `INSERT IGNORE INTO group_members (group_id, user_id, role) VALUES ${placeholders}`,
    params
  );
  return userIds;
};

const removeMember = async (groupId, userId) => {
  const result = await query('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [
    groupId,
    userId,
  ]);
  return Number(result.affectedRows) > 0;
};

/** Advances a member's read cursor monotonically (never moves it backwards). */
const touchLastRead = (groupId, userId, messageId) =>
  query(
    `UPDATE group_members
        SET last_read_message_id = GREATEST(last_read_message_id, ?)
      WHERE group_id = ? AND user_id = ?`,
    [messageId, groupId, userId]
  );

/**
 * Every group the user belongs to, enriched with:
 *   - `memberCount`
 *   - `unread`      : messages past their cursor and not authored by them
 *   - `mentioned`   : whether any of those unread messages @-mention them
 *   - `lastMessage` : the newest message (id + a short preview), if any
 *
 * Correlated subqueries keep this to two round-trips (groups, then the last
 * messages) instead of N+1.
 */
const listForUser = async (userId) => {
  const rows = await query(
    `SELECT g.*, gm.role, gm.last_read_message_id,
            (SELECT COUNT(*) FROM group_members m2 WHERE m2.group_id = g.id) AS member_count,
            (SELECT COUNT(*) FROM messages ms
               WHERE ms.group_id = g.id AND ms.id > gm.last_read_message_id
                 AND ms.from_user_id <> gm.user_id AND ms.type = 'text') AS unread,
            (SELECT COUNT(*) FROM messages ms
               WHERE ms.group_id = g.id AND ms.id > gm.last_read_message_id
                 AND ms.from_user_id <> gm.user_id AND ms.type = 'text'
                 AND ms.mention_user_ids LIKE CONCAT('%,', gm.user_id, ',%')) AS mention_unread,
            (SELECT ms.id FROM messages ms WHERE ms.group_id = g.id ORDER BY ms.id DESC LIMIT 1) AS last_message_id
       FROM group_members gm
       JOIN \`groups\` g ON g.id = gm.group_id
      WHERE gm.user_id = ?
      ORDER BY g.updated_at DESC`,
    [userId]
  );

  const lastIds = rows.map((r) => Number(r.last_message_id)).filter((n) => Number.isInteger(n) && n > 0);
  const lastById = new Map();
  if (lastIds.length > 0) {
    const placeholders = lastIds.map(() => '?').join(',');
    const lastRows = await query(
      `SELECT m.id, m.group_id, m.content, m.type, m.from_user_id, m.created_at,
              u.nickname AS from_nickname, u.avatar AS from_avatar
         FROM messages m
         LEFT JOIN users u ON u.id = m.from_user_id
        WHERE m.id IN (${placeholders})`,
      lastIds
    );
    for (const last of lastRows) lastById.set(Number(last.id), last);
  }

  return rows.map((row) => {
    const last = lastById.get(Number(row.last_message_id));
    return {
      ...toDTO(row),
      role: row.role,
      memberCount: Number(row.member_count) || 0,
      unread: Number(row.unread) || 0,
      mentioned: Number(row.mention_unread) > 0,
      lastMessage: last
        ? {
            id: Number(last.id),
            content: last.content,
            type: last.type,
            fromUserId: Number(last.from_user_id),
            fromNickname: last.from_nickname || null,
            fromAvatar: last.from_avatar || null,
            createdAt: last.created_at,
          }
        : null,
    };
  });
};

// ---------------------------------------------------------------------------
// Join requests (QQ-style apply-to-join)
// ---------------------------------------------------------------------------
const joinRequestDTO = (row) => ({
  id: Number(row.id),
  groupId: Number(row.group_id),
  status: row.status,
  message: row.message || null,
  createdAt: row.created_at,
  applicant: {
    id: Number(row.user_id),
    username: row.username,
    nickname: row.nickname,
    avatar: row.avatar || null,
  },
});

const findJoinRequest = (groupId, userId) =>
  query('SELECT * FROM group_join_requests WHERE group_id = ? AND user_id = ? LIMIT 1', [
    groupId,
    userId,
  ]).then((r) => r[0] || null);

const findJoinRequestById = (id) =>
  query('SELECT * FROM group_join_requests WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);

/** Upsert so a rejected applicant can apply again (status resets to pending). */
const upsertJoinRequest = async ({ groupId, userId, message }) => {
  await query(
    `INSERT INTO group_join_requests (group_id, user_id, message, status)
     VALUES (?, ?, ?, 'pending')
     ON DUPLICATE KEY UPDATE message = VALUES(message), status = 'pending', updated_at = UTC_TIMESTAMP()`,
    [groupId, userId, message || null]
  );
  return findJoinRequest(groupId, userId);
};

const updateJoinRequestStatus = (id, status) =>
  query('UPDATE group_join_requests SET status = ? WHERE id = ?', [status, id]);

/** Owner-appointed administrator ('admin') or demotion back to 'member'. */
const setRole = (groupId, userId, role) =>
  query('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?', [role, groupId, userId]);

/** A member's own in-group alias (群昵称). */
const setGroupNickname = (groupId, userId, nickname) =>
  query('UPDATE group_members SET nickname = ? WHERE group_id = ? AND user_id = ?', [nickname, groupId, userId]);

/** Files shared in the group (messages carrying a `file` attachment). */
const listFiles = (groupId) =>
  query(
    `SELECT m.id AS message_id, m.created_at, m.from_user_id,
            u.nickname AS from_nickname,
            a.id AS attachment_id, a.original_name, a.size, a.mime
       FROM messages m
       JOIN attachments a ON a.id = m.attachment_id
       LEFT JOIN users u ON u.id = m.from_user_id
      WHERE m.group_id = ? AND a.kind = 'file'
      ORDER BY m.id DESC
      LIMIT 200`,
    [groupId]
  ).then((rows) =>
    rows.map((r) => ({
      messageId: Number(r.message_id),
      attachmentId: Number(r.attachment_id),
      name: r.original_name,
      size: Number(r.size),
      mime: r.mime,
      fromUserId: Number(r.from_user_id),
      fromNickname: r.from_nickname || null,
      createdAt: r.created_at,
    }))
  );

const listJoinRequests = (groupId, status = 'pending') =>
  query(
    `SELECT r.*, u.username, u.nickname, u.avatar
       FROM group_join_requests r
       JOIN users u ON u.id = r.user_id
      WHERE r.group_id = ? AND r.status = ?
      ORDER BY r.created_at ASC
      LIMIT 100`,
    [groupId, status]
  ).then((rows) => rows.map(joinRequestDTO));

module.exports = {
  toDTO,
  findById,
  findByGroupNo,
  createGroup,
  updateGroup,
  dissolve,
  searchGroups,
  listMemberIds,
  listMembers,
  membershipOf,
  isMember,
  addMembers,
  removeMember,
  touchLastRead,
  listForUser,
  findJoinRequest,
  findJoinRequestById,
  upsertJoinRequest,
  updateJoinRequestStatus,
  listJoinRequests,
  setRole,
  setGroupNickname,
  listFiles,
  toPublicProfile: toPublic,
};
