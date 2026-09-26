'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');

const basePayload = (user) => ({
  sub: String(user.id),
  username: user.username,
  // token version lets the server invalidate *every* token of a user at once
  // (used by cross-tab global logout) without keeping a blacklist.
  tv: user.token_version ?? 0,
});

const signAccessToken = (user) =>
  jwt.sign({ ...basePayload(user), typ: 'access' }, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessTtlSec,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });

const signRefreshToken = (user) => {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ ...basePayload(user), typ: 'refresh', jti }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshTtlSec,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });
  return { token, jti, expiresAt: new Date(Date.now() + config.jwt.refreshTtlSec * 1000) };
};

const verifyAccessToken = (token) =>
  jwt.verify(token, config.jwt.accessSecret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });

const verifyRefreshToken = (token) =>
  jwt.verify(token, config.jwt.refreshSecret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
  });

/** Access token expiry in epoch milliseconds. */
const expiresAtMsOf = (token) => {
  const decoded = jwt.decode(token);
  return decoded && decoded.exp ? decoded.exp * 1000 : 0;
};

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  expiresAtMsOf,
};
