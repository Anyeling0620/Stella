'use strict';

const { query } = require('../db/pool');

const STATUS = { SENT: 0, DELIVERED: 1, READ: 2 };

/** `,3,7,` — comma-wrapped so `FIND_IN_SET` / LIKE membership tests are exact. */
const encodeMentions = (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const unique = [...new Set(ids)].filter((n) => Number.isInteger(n) && n > 0);
  return unique.length === 0 ? null : `,${unique.join(',')},`;
};

const decodeMentions = (value) => {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
};

/** Author + attachment columns are only present on queries that join them. */
const toDTO = (row) => {
  if (!row) return null;
  const dto = {
    id: Number(row.id),
    clientMsgId: row.client_msg_id || null,
    fromUserId: Number(row.from_user_id),
    // Group messages store 0 here (the column is NOT NULL for backwards
    // compatibility); consumers should branch on `groupId` for groups.
    toUserId: Number(row.to_user_id),
    groupId: row.group_id ? Number(row.group_id) : null,
    type: row.type || 'text',
    mentions: decodeMentions(row.mention_user_ids),
    attachmentId: row.attachment_id ? Number(row.attachment_id) : null,
    content: row.content,
    status: Number(row.status),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
  if (row.from_nickname !== undefined) {
    dto.fromUser = {
      id: Number(row.from_user_id),
      nickname: row.from_nickname,
      avatar: row.from_avatar || null,
    };
  }
  if (row.att_name !== undefined) {
    dto.attachment = row.attachment_id
      ? {
          id: Number(row.attachment_id),
          kind: row.att_kind,
          name: row.att_name,
          size: Number(row.att_size),
          mime: row.att_mime,
        }
      : null;
  }
  return dto;
};

const insert = async ({
  clientMsgId,
  fromUserId,
  toUserId,
  groupId = null,
  type = 'text',
  mentions = [],
  attachmentId = null,
  content,
}) => {
  try {
    const rows = await query(
      `INSERT INTO messages (client_msg_id, from_user_id, to_user_id, group_id, type, mention_user_ids, attachment_id, content, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [clientMsgId || null, fromUserId, toUserId, groupId, type, encodeMentions(mentions), attachmentId, content]
    );
    return findById(rows.insertId);
  } catch (err) {
    // Duplicate clientMsgId => the client retried a message we already stored.
    // Return the existing row so the operation stays idempotent.
    if (err && err.code === 'ER_DUP_ENTRY' && clientMsgId) {
      const existing = await findByClientId(clientMsgId);
      if (existing) return existing;
    }
    throw err;
  }
};

const findById = (id) =>
  query(
    `SELECT m.*, a.kind AS att_kind, a.original_name AS att_name, a.size AS att_size, a.mime AS att_mime
       FROM messages m
       LEFT JOIN attachments a ON a.id = m.attachment_id
      WHERE m.id = ? LIMIT 1`,
    [id]
  ).then((r) => toDTO(r[0]));

const findByClientId = (clientMsgId) =>
  query(
    `SELECT m.*, a.kind AS att_kind, a.original_name AS att_name, a.size AS att_size, a.mime AS att_mime
       FROM messages m
       LEFT JOIN attachments a ON a.id = m.attachment_id
      WHERE m.client_msg_id = ? LIMIT 1`,
    [clientMsgId]
  ).then((r) => toDTO(r[0]));

/**
 * Page of 1:1 history for one conversation, loaded newest-first then re-ordered
 * ascending. `beforeId` enables "load older" pagination.
 */
const history = async ({ userId, friendId, beforeId = 0, limit = 50 }) => {
  const params = [userId, friendId, friendId, userId];
  let sql = `SELECT m.*, a.kind AS att_kind, a.original_name AS att_name, a.size AS att_size, a.mime AS att_mime
               FROM messages m
               LEFT JOIN attachments a ON a.id = m.attachment_id
              WHERE ((m.from_user_id = ? AND m.to_user_id = ?) OR (m.from_user_id = ? AND m.to_user_id = ?))
                AND m.group_id IS NULL`;
  if (beforeId > 0) {
    sql += ' AND m.id < ?';
    params.push(beforeId);
  }
  sql += ' ORDER BY m.id DESC LIMIT ?';
  params.push(Math.min(limit, 200));
  const rows = await query(sql, params);
  // rows are DESC; reverse for chronological rendering.
  return rows.reverse().map(toDTO);
};

/** Page of group history, with the author joined in for per-bubble rendering. */
const groupHistory = async ({ groupId, beforeId = 0, limit = 50 }) => {
  const params = [groupId];
  let sql = `SELECT m.*, u.nickname AS from_nickname, u.avatar AS from_avatar,
                    a.kind AS att_kind, a.original_name AS att_name, a.size AS att_size, a.mime AS att_mime
               FROM messages m
               LEFT JOIN users u ON u.id = m.from_user_id
               LEFT JOIN attachments a ON a.id = m.attachment_id
              WHERE m.group_id = ?`;
  if (beforeId > 0) {
    sql += ' AND m.id < ?';
    params.push(beforeId);
  }
  sql += ' ORDER BY m.id DESC LIMIT ?';
  params.push(Math.min(limit, 200));
  const rows = await query(sql, params);
  return rows.reverse().map(toDTO);
};

/**
 * Incremental sync: every message the user sent, received, or that belongs to a
 * group they are a member of, with id > cursor. Powers both the WebSocket resume
 * and the polling fallback.
 *
 * A cursor of 0 means "I have no baseline" — returning the *oldest* rows would
 * hand back ancient history, so in that case the newest page is returned instead
 * (ascending) which is what a freshly-booted client actually needs.
 */
const incremental = async ({ userId, sinceId = 0, limit = 100 }) => {
  const size = Math.min(limit, 200);
  const scope = `(m.to_user_id = ? OR m.from_user_id = ?
                  OR m.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?))`;
  const select = `SELECT m.*, u.nickname AS from_nickname, u.avatar AS from_avatar,
                         a.kind AS att_kind, a.original_name AS att_name, a.size AS att_size, a.mime AS att_mime
                    FROM messages m
                    LEFT JOIN users u ON u.id = m.from_user_id
                    LEFT JOIN attachments a ON a.id = m.attachment_id`;
  if (sinceId > 0) {
    const rows = await query(
      `${select}
        WHERE ${scope} AND m.id > ?
        ORDER BY m.id ASC
        LIMIT ?`,
      [userId, userId, userId, sinceId, size]
    );
    return rows.map(toDTO);
  }
  const rows = await query(
    `${select}
      WHERE ${scope}
      ORDER BY m.id DESC
      LIMIT ?`,
    [userId, userId, userId, size]
  );
  return rows.reverse().map(toDTO);
};

const markDelivered = (ids) => {
  if (!ids.length) return Promise.resolve();
  const placeholders = ids.map(() => '?').join(',');
  return query(`UPDATE messages SET status = ? WHERE id IN (${placeholders}) AND status = 0`, [
    STATUS.DELIVERED,
    ...ids,
  ]);
};

/**
 * Messages among `ids` that `userId` has "received" but not yet read:
 *   - 1:1 rows addressed to them and still unread, or
 *   - group rows in a group they belong to, authored by someone else.
 * Returns the routing fields so the service can split the two paths.
 */
const receivedUnread = (userId, ids) => {
  if (!ids.length) return Promise.resolve([]);
  const placeholders = ids.map(() => '?').join(',');
  return query(
    `SELECT m.id, m.from_user_id, m.to_user_id, m.group_id
       FROM messages m
      WHERE m.id IN (${placeholders})
        AND m.from_user_id <> ?
        AND (
          (m.group_id IS NULL AND m.to_user_id = ? AND m.status < 2)
          OR (m.group_id IS NOT NULL
              AND m.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?))
        )`,
    [...ids, userId, userId, userId]
  );
};

const markRead = (ids) => {
  if (!ids.length) return Promise.resolve();
  const placeholders = ids.map(() => '?').join(',');
  return query(`UPDATE messages SET status = 2 WHERE id IN (${placeholders})`, ids);
};

/** Author profile for a freshly inserted group message (fan-out enrichment). */
const authorOf = (userId) =>
  query('SELECT id, nickname, avatar FROM users WHERE id = ? LIMIT 1', [userId]).then((r) =>
    r[0] ? { id: Number(r[0].id), nickname: r[0].nickname, avatar: r[0].avatar || null } : null
  );

module.exports = {
  STATUS,
  encodeMentions,
  decodeMentions,
  toDTO,
  insert,
  findById,
  findByClientId,
  history,
  groupHistory,
  incremental,
  markDelivered,
  receivedUnread,
  markRead,
  authorOf,
};
