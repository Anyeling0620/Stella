'use strict';

const { query } = require('../db/pool');

/**
 * Privacy / notification switches. Absent rows fall back to the same defaults
 * defined here, so behaviour is identical before the first write.
 */
const DEFAULTS = {
  addByUsername: true,
  addByInvite: true,
  addByGroup: true,
  requireVerification: true,
  notifyDesktop: true,
  notifySound: true,
  notifyPreview: true,
};

const fromRow = (row) =>
  row
    ? {
        addByUsername: Boolean(row.add_by_username),
        addByInvite: Boolean(row.add_by_invite),
        addByGroup: Boolean(row.add_by_group),
        requireVerification: Boolean(row.require_verification),
        notifyDesktop: Boolean(row.notify_desktop),
        notifySound: Boolean(row.notify_sound),
        notifyPreview: Boolean(row.notify_preview),
      }
    : { ...DEFAULTS };

const get = (userId) =>
  query('SELECT * FROM user_settings WHERE user_id = ? LIMIT 1', [userId]).then((r) => fromRow(r[0]));

const getFor = (userIds) =>
  query('SELECT * FROM user_settings WHERE user_id IN (?)', [userIds]).then((rows) => {
    const map = new Map();
    for (const row of rows) map.set(Number(row.user_id), fromRow(row));
    return (id) => map.get(Number(id)) || { ...DEFAULTS };
  });

const COLUMNS = {
  addByUsername: 'add_by_username',
  addByInvite: 'add_by_invite',
  addByGroup: 'add_by_group',
  requireVerification: 'require_verification',
  notifyDesktop: 'notify_desktop',
  notifySound: 'notify_sound',
  notifyPreview: 'notify_preview',
};

const bool = (v) => (v ? 1 : 0);

const upsert = async (userId, patch) => {
  await query('INSERT IGNORE INTO user_settings (user_id) VALUES (?)', [userId]);
  const assignments = [];
  const params = [];
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (patch[key] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(bool(patch[key]));
    }
  }
  if (assignments.length > 0) {
    params.push(userId);
    await query(`UPDATE user_settings SET ${assignments.join(', ')} WHERE user_id = ?`, params);
  }
  return get(userId);
};

module.exports = { DEFAULTS, get, getFor, upsert };
