'use strict';

const { query } = require('../db/pool');

const toDTO = (row) => ({
  id: Number(row.id),
  level: row.level,
  content: row.content,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
});

const insert = async ({ content, level = 'info' }) => {
  const rows = await query('INSERT INTO system_notices (level, content) VALUES (?, ?)', [level, content]);
  const created = await query('SELECT * FROM system_notices WHERE id = ? LIMIT 1', [rows.insertId]);
  return toDTO(created[0]);
};

/**
 * Cursor pull for announcements. Since the very first notice may predate the
 * client, a cursor of 0 returns the newest page rather than the oldest.
 */
const listSince = async ({ sinceId = 0, limit = 50 }) => {
  const size = Math.min(limit, 200);
  if (sinceId > 0) {
    const rows = await query('SELECT * FROM system_notices WHERE id > ? ORDER BY id ASC LIMIT ?', [
      sinceId,
      size,
    ]);
    return rows.map(toDTO);
  }
  const rows = await query('SELECT * FROM system_notices ORDER BY id DESC LIMIT ?', [size]);
  return rows.reverse().map(toDTO);
};

module.exports = { insert, listSince, toDTO };
