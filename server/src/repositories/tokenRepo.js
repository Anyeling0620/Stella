'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Persists a refresh token (stored hashed — never in plaintext). */
const insert = ({ userId, jti, token, expiresAt, sessionId = null }) =>
  query('INSERT INTO refresh_tokens (user_id, jti, token_hash, expires_at, session_id) VALUES (?, ?, ?, ?, ?)', [
    userId,
    jti,
    hash(token),
    expiresAt,
    sessionId,
  ]);

const findActiveByJti = (jti) =>
  query(
    'SELECT * FROM refresh_tokens WHERE jti = ? AND revoked = 0 AND expires_at > UTC_TIMESTAMP() LIMIT 1',
    [jti]
  ).then((r) => r[0] || null);

/**
 * Like `findActiveByJti` but includes revoked rows, so the refresh flow can
 * distinguish "already rotated a moment ago" (benign concurrent refresh) from
 * "replayed long after rotation" (token theft).
 */
const findByJti = (jti) =>
  query('SELECT * FROM refresh_tokens WHERE jti = ? LIMIT 1', [jti]).then((r) => r[0] || null);

/**
 * Marks a token used. When it is part of a rotation, the replacement jti and a
 * timestamp are recorded so a near-simultaneous second presentation (two tabs
 * sharing one cookie) can be told apart from a genuine replay.
 */
const revokeByJti = (jti, { replacedByJti = null } = {}) =>
  query('UPDATE refresh_tokens SET revoked = 1, replaced_by_jti = ?, rotated_at = UTC_TIMESTAMP(3) WHERE jti = ?', [
    replacedByJti,
    jti,
  ]);

const revokeAllForUser = (userId) =>
  query('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0', [userId]);

/** Revokes the refresh tokens belonging to one session lineage. */
const revokeSession = ({ userId, sessionId }) =>
  query('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND session_id = ? AND revoked = 0', [
    userId,
    sessionId,
  ]);

/**
 * Revokes every refresh token a user holds except the caller's own session.
 * Legacy rows with no `session_id` are treated as "other" and revoked too.
 */
const revokeOthers = ({ userId, keepSessionId }) =>
  query(
    'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0 AND (session_id IS NULL OR session_id <> ?)',
    [userId, keepSessionId || '']
  );

const deleteExpired = () => query('DELETE FROM refresh_tokens WHERE expires_at < UTC_TIMESTAMP()');

module.exports = {
  hash,
  insert,
  findActiveByJti,
  findByJti,
  revokeByJti,
  revokeAllForUser,
  revokeSession,
  revokeOthers,
  deleteExpired,
};
