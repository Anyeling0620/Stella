'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');

/**
 * Active-session repository — the Web replacement for a native "device list".
 *
 * A "session" is one browser login lineage. Every refresh rotation keeps the
 * same `session_id`, so revoking the row instantly kills the whole device (its
 * refresh lineage), while `users.token_version` remains the global kill switch.
 */

const newSessionId = () => crypto.randomUUID();

const create = ({ userId, sessionId, userAgent = null, ip = null }) =>
  query(
    `INSERT INTO sessions (user_id, session_id, user_agent, ip)
     VALUES (?, ?, ?, ?)`,
    [userId, sessionId, userAgent ? String(userAgent).slice(0, 255) : null, ip ? String(ip).slice(0, 45) : null]
  );

const findBySessionId = (sessionId) =>
  query('SELECT * FROM sessions WHERE session_id = ? LIMIT 1', [sessionId]).then((r) => r[0] || null);

/** True when the session exists and has not been revoked. */
const isActive = (sessionId) =>
  query('SELECT 1 FROM sessions WHERE session_id = ? AND revoked = 0 LIMIT 1', [sessionId]).then(
    (r) => r.length > 0
  );

/** Records the newest refresh jti for a lineage (called on every rotation). */
const touchCurrentJti = ({ sessionId, jti }) =>
  query('UPDATE sessions SET current_jti = ?, last_used_at = UTC_TIMESTAMP() WHERE session_id = ?', [
    jti,
    sessionId,
  ]);

const listForUser = (userId) =>
  query(
    `SELECT session_id, user_agent, ip, created_at, last_used_at, current_jti, revoked
       FROM sessions
      WHERE user_id = ?
      ORDER BY revoked ASC, last_used_at DESC`,
    [userId]
  );

/** Revokes one session, scoped to its owner so an id guess cannot cross users. */
const revoke = ({ userId, sessionId }) =>
  query(
    'UPDATE sessions SET revoked = 1, revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND session_id = ? AND revoked = 0',
    [userId, sessionId]
  );

/** Revokes every session of a user except the caller's current one. */
const revokeOthers = ({ userId, keepSessionId }) =>
  query(
    'UPDATE sessions SET revoked = 1, revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked = 0 AND session_id <> ?',
    [userId, keepSessionId || '']
  );

const revokeAllForUser = (userId) =>
  query('UPDATE sessions SET revoked = 1, revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked = 0', [userId]);

module.exports = {
  newSessionId,
  create,
  findBySessionId,
  isActive,
  touchCurrentJti,
  listForUser,
  revoke,
  revokeOthers,
  revokeAllForUser,
};
