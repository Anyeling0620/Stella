'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');

/**
 * Per-user friend invite links (the Web counterpart of a QR code). A valid,
 * unexpired, unrevoked token is enough to send a friend request without first
 * searching for the username — and it respects the owner's `add_by_invite`.
 */
const newToken = () => crypto.randomBytes(16).toString('hex'); // 32 hex chars

const create = async ({ userId, ttlMs }) => {
  const token = newToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  await query('INSERT INTO friend_invite_links (token, user_id, expires_at) VALUES (?, ?, ?)', [
    token,
    userId,
    expiresAt,
  ]);
  return { token, expiresAt };
};

/** Resolves a usable (unexpired, unrevoked) link to its owner id, else null. */
const findActive = (token) =>
  query(
    'SELECT * FROM friend_invite_links WHERE token = ? AND revoked = 0 AND expires_at > UTC_TIMESTAMP() LIMIT 1',
    [token]
  ).then((r) => (r[0] ? { userId: Number(r[0].user_id), expiresAt: r[0].expires_at } : null));

const listForUser = (userId) =>
  query(
    `SELECT token, expires_at, revoked FROM friend_invite_links
      WHERE user_id = ? ORDER BY id DESC LIMIT 20`,
    [userId]
  ).then((rows) =>
    rows.map((r) => ({ token: r.token, expiresAt: r.expires_at, revoked: Boolean(r.revoked) }))
  );

const revoke = async ({ userId, token }) => {
  const result = await query('UPDATE friend_invite_links SET revoked = 1 WHERE user_id = ? AND token = ?', [
    userId,
    token,
  ]);
  return Number(result.affectedRows) > 0;
};

module.exports = { create, findActive, listForUser, revoke };
