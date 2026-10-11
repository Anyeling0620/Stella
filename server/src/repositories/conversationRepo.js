'use strict';

const { query } = require('../db/pool');

/**
 * Per-user conversation state (pin / mute / clear watermark). Absent rows fall
 * back to the defaults below, so behaviour is identical before the first write.
 */
const DEFAULTS = { pinned: false, muted: false, clearedBeforeId: 0 };

const fromRow = (row) =>
  row
    ? {
        pinned: Boolean(row.pinned),
        muted: Boolean(row.muted),
        clearedBeforeId: Number(row.cleared_before_id) || 0,
      }
    : { ...DEFAULTS };

const get = ({ userId, peerKind, peerId }) =>
  query(
    'SELECT * FROM conversation_settings WHERE user_id = ? AND peer_kind = ? AND peer_id = ? LIMIT 1',
    [userId, peerKind, peerId]
  ).then((r) => fromRow(r[0]));

/** `kind:id` -> settings, for merging into a conversation list in one read. */
const listForUser = (userId) =>
  query('SELECT * FROM conversation_settings WHERE user_id = ?', [userId]).then((rows) => {
    const map = new Map();
    for (const row of rows) map.set(`${row.peer_kind}:${Number(row.peer_id)}`, fromRow(row));
    return map;
  });

const countPinned = (userId) =>
  query('SELECT COUNT(*) AS n FROM conversation_settings WHERE user_id = ? AND pinned = 1', [userId]).then((r) =>
    Number(r[0] ? r[0].n : 0)
  );

/**
 * Upsert pin/mute flags.
 *
 * Only the supplied flags are written — an omitted one must keep its stored
 * value. That rules out `VALUES(col) = NULL` as the "unchanged" marker: `pinned`
 * and `muted` are `NOT NULL`, so under STRICT_TRANS_TABLES a NULL placeholder
 * made the very first write fail with `Column 'muted' cannot be null` (1048).
 * Instead the statement is built per call, so untouched columns are simply left
 * out of both the INSERT (they take their DEFAULT 0) and the UPDATE.
 */
const setFlags = async ({ userId, peerKind, peerId, pinned, muted }) => {
  const columns = ['user_id', 'peer_kind', 'peer_id'];
  const values = [userId, peerKind, peerId];
  const assignments = [];
  const flag = (value) => (value ? 1 : 0);

  if (pinned !== undefined) {
    columns.push('pinned');
    values.push(flag(pinned));
    assignments.push('pinned = VALUES(pinned)');
  }
  if (muted !== undefined) {
    columns.push('muted');
    values.push(flag(muted));
    assignments.push('muted = VALUES(muted)');
  }
  if (assignments.length === 0) return get({ userId, peerKind, peerId });

  await query(
    `INSERT INTO conversation_settings (${columns.join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${assignments.join(', ')}`,
    values
  );
  return get({ userId, peerKind, peerId });
};

/** Raises the clear watermark (never lowers it). */
const setCleared = async ({ userId, peerKind, peerId, clearedBeforeId }) => {
  await query(
    `INSERT INTO conversation_settings (user_id, peer_kind, peer_id, cleared_before_id)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE cleared_before_id = GREATEST(cleared_before_id, VALUES(cleared_before_id))`,
    [userId, peerKind, peerId, clearedBeforeId]
  );
  return get({ userId, peerKind, peerId });
};

module.exports = { DEFAULTS, get, listForUser, countPinned, setFlags, setCleared };
