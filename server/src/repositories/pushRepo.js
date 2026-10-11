'use strict';

const { query } = require('../db/pool');

/** Web Push subscription persistence (one row per browser/device). */
const upsert = ({ userId, endpoint, p256dh, auth, userAgent = null }) =>
  query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent)`,
    [userId, endpoint, p256dh, auth, userAgent ? String(userAgent).slice(0, 255) : null]
  );

const removeByEndpoint = (endpoint) => query('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);

const listForUser = (userId) =>
  query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);

const removeById = (id) => query('DELETE FROM push_subscriptions WHERE id = ?', [id]);

module.exports = { upsert, removeByEndpoint, listForUser, removeById };
