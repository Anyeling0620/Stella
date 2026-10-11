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

const iso = (value) => (value instanceof Date ? value.toISOString() : value);

const QUOTE_COLUMNS = `q.content AS quote_content, q.type AS quote_type,
                       q.from_user_id AS quote_from_user_id, q.recalled_at AS quote_recalled,
                       q.attachment_id AS quote_attachment_id`;
const QUOTE_JOIN = 'LEFT JOIN messages q ON q.id = m.quote_id';

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
    recalled: Boolean(row.recalled_at),
    recalledAt: row.recalled_at ? iso(row.recalled_at) : null,
    quoteId: row.quote_id ? Number(row.quote_id) : null,
    createdAt: iso(row.created_at),
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
  if (row.quote_from_user_id !== undefined) {
    dto.quote = row.quote_id
      ? {
          id: Number(row.quote_id),
          content: row.quote_recalled ? null : row.quote_content,
          type: row.quote_type || 'text',
          fromUserId: Number(row.quote_from_user_id),
          recalled: Boolean(row.quote_recalled),
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
  quoteId = null,
  content,
}) => {
  try {
    const rows = await query(
      `INSERT INTO messages (client_msg_id, from_user_id, to_user_id, group_id, type, mention_user_ids, attachment_id, quote_id, content, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [clientMsgId || null, fromUserId, toUserId, groupId, type, encodeMentions(mentions), attachmentId, quoteId, content]
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
    `SELECT m.*, a.kind AS att_kind, a.original_name AS att_name, a.size AS att_size, a.mime AS att_mime, ${QUOTE_COLUMNS}
       FROM messages m
       LEFT JOIN attachments a ON a.id = m.attachment_id
       ${QUOTE_JOIN}
      WHERE m.id = ? LIMIT 1`,
    [id]
  ).then((r) => toDTO(r[0]));

const findByClientId = (clientMsgId) =>
  query(
    `SELECT m.*, a.kind AS att_kind, a.original_name AS att_name, a.size AS att_size, a.mime AS att_mime, ${QUOTE_COLUMNS}
       FROM messages m
       LEFT JOIN attachments a ON a.id = m.attachment_id
       ${QUOTE_JOIN}
      WHERE m.client_msg_id = ? LIMIT 1`,
    [clientMsgId]
  ).then((r) => toDTO(r[0]));

/** Marks a message recalled (2-minute window enforced in the service). */
const recall = async (id, fromUserId) => {
  const result = await query(
    'UPDATE messages SET recalled_at = UTC_TIMESTAMP(3), content = ? WHERE id = ? AND from_user_id = ? AND recalled_at IS NULL',
    ['', id, fromUserId]
  );
  return Number(result.affectedRows) > 0;
};

/** Hides a message for one user only (local delete). */
const hideForUser = (userId, messageId) =>
  query('INSERT IGNORE INTO message_hidden (user_id, message_id) VALUES (?, ?)', [userId, messageId]);

const hiddenSet = (userId, ids) => {
  if (!ids.length) return Promise.resolve(new Set());
  const placeholders = ids.map(() => '?').join(',');
  return query(
    `SELECT message_id FROM message_hidden WHERE user_id = ? AND message_id IN (${placeholders})`,
    [userId, ...ids]
  ).then((rows) => new Set(rows.map((r) => Number(r.message_id))));
};

/**
 * Page of 1:1 history for one conversation, loaded newest-first then re-ordered
 * ascending. `beforeId` enables "load older"; `clearedBefore` (and hidden rows)
 * let the reader's "清空会话" / "删除" choices take effect.
 */
const history = async ({ userId, friendId, beforeId = 0, clearedBefore = 0, limit = 50 }) => {
  const params = [userId, friendId, friendId, userId];
  let sql = `SELECT m.*, a.kind AS att_kind, a.original_name AS att_name, a.size AS att_size, a.mime AS att_mime, ${QUOTE_COLUMNS}
               FROM messages m
               LEFT JOIN attachments a ON a.id = m.attachment_id
               ${QUOTE_JOIN}
              WHERE ((m.from_user_id = ? AND m.to_user_id = ?) OR (m.from_user_id = ? AND m.to_user_id = ?))
                AND m.group_id IS NULL`;
  if (beforeId > 0) {
    sql += ' AND m.id < ?';
    params.push(beforeId);
  }
  if (clearedBefore > 0) {
    sql += ' AND m.id > ?';
    params.push(clearedBefore);
  }
  sql += ' AND m.id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)';
  params.push(userId);
  sql += ' ORDER BY m.id DESC LIMIT ?';
  params.push(Math.min(limit, 200));
  const rows = await query(sql, params);
  // rows are DESC; reverse for chronological rendering.
  return rows.reverse().map(toDTO);
};

/** Page of group history, with the author joined in for per-bubble rendering. */
const groupHistory = async ({ groupId, userId = 0, beforeId = 0, clearedBefore = 0, limit = 50 }) => {
  const params = [groupId];
  let sql = `SELECT m.*, u.nickname AS from_nickname, u.avatar AS from_avatar,
                    a.kind AS att_kind, a.original_name AS att_name, a.size AS att_size, a.mime AS att_mime, ${QUOTE_COLUMNS}
               FROM messages m
               LEFT JOIN users u ON u.id = m.from_user_id
               LEFT JOIN attachments a ON a.id = m.attachment_id
               ${QUOTE_JOIN}
              WHERE m.group_id = ?`;
  if (beforeId > 0) {
    sql += ' AND m.id < ?';
    params.push(beforeId);
  }
  if (clearedBefore > 0) {
    sql += ' AND m.id > ?';
    params.push(clearedBefore);
  }
  if (userId) {
    sql += ' AND m.id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)';
    params.push(userId);
  }
  sql += ' ORDER BY m.id DESC LIMIT ?';
  params.push(Math.min(limit, 200));
  const rows = await query(sql, params);
  return rows.reverse().map(toDTO);
};

/**
 * In-conversation search (1:1 or group), newest-first, excludes hidden.
 *
 * Two modes:
 * - keyword → text messages whose content matches (the classic 搜索).
 * - date-only (`from`/`to`) → every jumpable row of that window (any media
 *   type). `system` notices are excluded because they render without a
 *   `data-message-id` target, so a result could never be scrolled to.
 *
 * `from`/`to` are pre-normalized UTC 'YYYY-MM-DD HH:mm:ss' strings: the pool
 * pins the session to UTC (see db/pool.js), matching how `created_at` is stored.
 */
const search = async ({ userId, friendId = 0, groupId = 0, keyword = '', from = null, to = null, limit = 60 }) => {
  const kw = (keyword || '').trim();
  const params = [];
  let sql = `SELECT m.*, u.nickname AS from_nickname, u.avatar AS from_avatar,
                    a.kind AS att_kind, a.original_name AS att_name, a.size AS att_size, a.mime AS att_mime, ${QUOTE_COLUMNS}
               FROM messages m
               LEFT JOIN users u ON u.id = m.from_user_id
               LEFT JOIN attachments a ON a.id = m.attachment_id
               ${QUOTE_JOIN}
              WHERE m.recalled_at IS NULL`;
  if (kw) {
    sql += " AND m.type = 'text' AND m.content LIKE ?";
    params.push(`%${kw}%`);
  } else {
    sql += " AND m.type <> 'system'";
  }
  if (from) {
    sql += ' AND m.created_at >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND m.created_at < ?';
    params.push(to);
  }
  if (groupId) {
    sql += ' AND m.group_id = ?';
    params.push(groupId);
  } else {
    sql += ' AND m.group_id IS NULL AND ((m.from_user_id = ? AND m.to_user_id = ?) OR (m.from_user_id = ? AND m.to_user_id = ?))';
    params.push(userId, friendId, friendId, userId);
  }
  sql += ' AND m.id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)';
  params.push(userId);
  sql += ' ORDER BY m.id DESC LIMIT ?';
  params.push(Math.min(limit, 200));
  return query(sql, params).then((rows) => rows.map(toDTO));
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
                         a.kind AS att_kind, a.original_name AS att_name, a.size AS att_size, a.mime AS att_mime, ${QUOTE_COLUMNS}
                    FROM messages m
                    LEFT JOIN users u ON u.id = m.from_user_id
                    LEFT JOIN attachments a ON a.id = m.attachment_id
                    ${QUOTE_JOIN}`;
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

/** Newest message id in a conversation (the "clear history" watermark). */
const maxIdInConversation = ({ peerKind, peerId, userId }) => {
  if (peerKind === 'group') {
    return query('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE group_id = ?', [peerId]).then((r) =>
      Number(r[0].m)
    );
  }
  return query(
    `SELECT COALESCE(MAX(id), 0) AS m FROM messages
      WHERE group_id IS NULL AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
    [userId, peerId, peerId, userId]
  ).then((r) => Number(r[0].m));
};

module.exports = {
  STATUS,
  encodeMentions,
  decodeMentions,
  toDTO,
  insert,
  findById,
  findByClientId,
  recall,
  hideForUser,
  hiddenSet,
  history,
  groupHistory,
  search,
  maxIdInConversation,
  incremental,
  markDelivered,
  receivedUnread,
  markRead,
  authorOf,
};
