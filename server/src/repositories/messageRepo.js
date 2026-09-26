'use strict';

const { query } = require('../db/pool');

const STATUS = { SENT: 0, DELIVERED: 1, READ: 2 };

const toDTO = (row) => {
  if (!row) return null;
  return {
    id: Number(row.id),
    clientMsgId: row.client_msg_id || null,
    fromUserId: Number(row.from_user_id),
    toUserId: Number(row.to_user_id),
    content: row.content,
    status: Number(row.status),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
};

const insert = async ({ clientMsgId, fromUserId, toUserId, content }) => {
  try {
    const rows = await query(
      'INSERT INTO messages (client_msg_id, from_user_id, to_user_id, content, status) VALUES (?, ?, ?, ?, 0)',
      [clientMsgId || null, fromUserId, toUserId, content]
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
  query('SELECT * FROM messages WHERE id = ? LIMIT 1', [id]).then((r) => toDTO(r[0]));

const findByClientId = (clientMsgId) =>
  query('SELECT * FROM messages WHERE client_msg_id = ? LIMIT 1', [clientMsgId]).then((r) => toDTO(r[0]));

/**
 * Page of history for one conversation, loaded newest-first then re-ordered
 * ascending. `beforeId` enables "load older" pagination.
 */
const history = async ({ userId, friendId, beforeId = 0, limit = 50 }) => {
  const params = [userId, friendId, friendId, userId];
  let sql = `SELECT * FROM messages
              WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`;
  if (beforeId > 0) {
    sql += ' AND id < ?';
    params.push(beforeId);
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Math.min(limit, 200));
  const rows = await query(sql, params);
  // rows are DESC; reverse for chronological rendering.
  return rows.reverse().map(toDTO);
};

/**
 * Incremental sync: every message the user sent or received with id > cursor.
 * Powers both the WebSocket resume and the polling fallback.
 *
 * A cursor of 0 means "I have no baseline" — returning the *oldest* rows would
 * hand back ancient history, so in that case the newest page is returned instead
 * (ascending) which is what a freshly-booted client actually needs.
 */
const incremental = async ({ userId, sinceId = 0, limit = 100 }) => {
  const size = Math.min(limit, 200);
  if (sinceId > 0) {
    const rows = await query(
      `SELECT * FROM messages
        WHERE (to_user_id = ? OR from_user_id = ?) AND id > ?
        ORDER BY id ASC
        LIMIT ?`,
      [userId, userId, sinceId, size]
    );
    return rows.map(toDTO);
  }
  const rows = await query(
    `SELECT * FROM messages
      WHERE (to_user_id = ? OR from_user_id = ?)
      ORDER BY id DESC
      LIMIT ?`,
    [userId, userId, size]
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

/** Received-but-unread messages owned by `userId` among `ids`. */
const pendingReceived = (userId, ids) => {
  if (!ids.length) return Promise.resolve([]);
  const placeholders = ids.map(() => '?').join(',');
  return query(
    `SELECT id, from_user_id FROM messages WHERE id IN (${placeholders}) AND to_user_id = ? AND status < 2`,
    [...ids, userId]
  );
};

const markRead = (ids) => {
  if (!ids.length) return Promise.resolve();
  const placeholders = ids.map(() => '?').join(',');
  return query(`UPDATE messages SET status = 2 WHERE id IN (${placeholders})`, ids);
};

module.exports = {
  STATUS,
  toDTO,
  insert,
  findById,
  findByClientId,
  history,
  incremental,
  markDelivered,
  pendingReceived,
  markRead,
};
