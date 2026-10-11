'use strict';

const { query } = require('../db/pool');

/**
 * Directed block list. `hasAnyBlock(a, b)` is the chat gate: if either party
 * has blocked the other, messages must be refused (with a neutral message that
 * does not reveal who blocked whom).
 */
const add = ({ userId, blockedId }) =>
  query('INSERT IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)', [userId, blockedId]);

const remove = async ({ userId, blockedId }) => {
  const result = await query('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', [userId, blockedId]);
  return Number(result.affectedRows) > 0;
};

const isBlocked = (blockerId, targetId) =>
  query('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ? LIMIT 1', [blockerId, targetId]).then(
    (r) => r.length > 0
  );

/** True when either direction is blocked. Used by the message gate. */
const hasAnyBlock = (a, b) =>
  query(
    'SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?) LIMIT 1',
    [a, b, b, a]
  ).then((r) => r.length > 0);

/** The users I have blocked, for the blacklist manager. */
const list = (userId) =>
  query(
    `SELECT u.id, u.username, u.nickname, u.avatar, b.created_at AS blocked_at
       FROM blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.user_id = ?
      ORDER BY b.id DESC`,
    [userId]
  ).then((rows) =>
    rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      nickname: r.nickname,
      avatar: r.avatar || null,
      blockedAt: r.blocked_at,
    }))
  );

module.exports = { add, remove, isBlocked, hasAnyBlock, list };
