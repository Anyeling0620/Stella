'use strict';

const { query } = require('../db/pool');

const PUBLIC_COLUMNS = 'id, username, nickname, avatar, bio, token_version, last_seen_at, created_at';

/** Strips internal fields and normalises types for the wire. */
const toPublic = (row) => {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    nickname: row.nickname,
    avatar: row.avatar || null,
    bio: row.bio || null,
    createdAt: row.created_at,
  };
};

const findByUsername = (username) =>
  query('SELECT * FROM users WHERE username = ? LIMIT 1', [username]).then((r) => r[0] || null);

const findById = (id) => query('SELECT * FROM users WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);

const findPublicById = (id) =>
  query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ? LIMIT 1`, [id]).then((r) => r[0] || null);

const create = async ({ username, passwordHash, nickname }) => {
  const rows = await query(
    'INSERT INTO users (username, password_hash, nickname) VALUES (?, ?, ?)',
    [username, passwordHash, nickname]
  );
  return findById(rows.insertId);
};

/**
 * Search by username prefix or nickname substring, excluding the caller and
 * users that are already friends.
 */
const search = ({ userId, keyword, limit = 20 }) => {
  const like = `${keyword}%`;
  const contains = `%${keyword}%`;
  return query(
    `SELECT ${PUBLIC_COLUMNS} FROM users
      LEFT JOIN user_settings s ON s.user_id = users.id
      WHERE users.id <> ?
        AND deleted_at IS NULL
        AND COALESCE(s.add_by_username, 1) = 1
        AND (username LIKE ? OR nickname LIKE ?)
        AND users.id NOT IN (SELECT friend_id FROM friendships WHERE user_id = ?)
        AND users.id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = ?)
        AND users.id NOT IN (SELECT user_id FROM blocks WHERE blocked_id = ?)
      ORDER BY (username = ?) DESC, username ASC
      LIMIT ?`,
    [userId, like, contains, userId, userId, userId, keyword, limit]
  ).then((rows) => rows.map((r) => ({ ...toPublic(r), isFriend: false })));
};

const incrementTokenVersion = async (id) => {
  await query('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [id]);
  return findById(id);
};

/**
 * Partial profile update. Only the keys present in `patch` are written, so
 * omitting a field leaves it untouched. `users.updated_at` bumps automatically.
 */
const updateProfile = async (id, patch) => {
  const assignments = [];
  const params = [];

  if (patch.nickname !== undefined) {
    assignments.push('nickname = ?');
    params.push(patch.nickname);
  }
  if (patch.avatar !== undefined) {
    assignments.push('avatar = ?');
    params.push(patch.avatar);
  }
  if (patch.bio !== undefined) {
    assignments.push('bio = ?');
    params.push(patch.bio);
  }
  if (assignments.length === 0) return findById(id);

  params.push(id);
  await query(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, params);
  return findById(id);
};

const updatePassword = (id, passwordHash) =>
  query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);

/** Soft delete (注销): keeps the row so the cooling period can restore it. */
const setDeleted = (id, when = new Date()) => query('UPDATE users SET deleted_at = ? WHERE id = ?', [when, id]);

const clearDeleted = (id) => query('UPDATE users SET deleted_at = NULL WHERE id = ?', [id]);

/** Moderation hooks (basic risk control): mute until a time, or ban outright. */
const setModeration = async (id, { mutedUntil, banned } = {}) => {
  const assignments = [];
  const params = [];
  if (mutedUntil !== undefined) {
    assignments.push('muted_until = ?');
    params.push(mutedUntil);
  }
  if (banned !== undefined) {
    assignments.push('banned = ?');
    params.push(banned ? 1 : 0);
  }
  if (assignments.length === 0) return findById(id);
  params.push(id);
  await query(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, params);
  return findById(id);
};

const touchLastSeen = (id) => query('UPDATE users SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [id]);

module.exports = {
  toPublic,
  findByUsername,
  findById,
  findPublicById,
  create,
  search,
  incrementTokenVersion,
  updateProfile,
  updatePassword,
  setDeleted,
  clearDeleted,
  setModeration,
  touchLastSeen,
};
