'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Persists a refresh token (stored hashed — never in plaintext). */
const insert = ({ userId, jti, token, expiresAt }) =>
  query('INSERT INTO refresh_tokens (user_id, jti, token_hash, expires_at) VALUES (?, ?, ?, ?)', [
    userId,
    jti,
    hash(token),
    expiresAt,
  ]);

const findActiveByJti = (jti) =>
  query(
    'SELECT * FROM refresh_tokens WHERE jti = ? AND revoked = 0 AND expires_at > UTC_TIMESTAMP() LIMIT 1',
    [jti]
  ).then((r) => r[0] || null);

const revokeByJti = (jti) => query('UPDATE refresh_tokens SET revoked = 1 WHERE jti = ?', [jti]);

const revokeAllForUser = (userId) =>
  query('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0', [userId]);

const deleteExpired = () => query('DELETE FROM refresh_tokens WHERE expires_at < UTC_TIMESTAMP()');

module.exports = { hash, insert, findActiveByJti, revokeByJti, revokeAllForUser, deleteExpired };
