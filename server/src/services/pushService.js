'use strict';

const webpush = require('web-push');
const config = require('../config');
const pushRepo = require('../repositories/pushRepo');
const userSettingsRepo = require('../repositories/userSettingsRepo');
const { AppError } = require('../utils/errors');
const { createLogger } = require('../utils/logger');

const log = createLogger('push');

/**
 * Web Push (chapter 10).
 *
 * VAPID keys come from env; if absent the server generates an ephemeral pair at
 * boot so dev works out of the box (subscriptions then die on restart — set real
 * keys in production).
 */
let ready = false;

function init() {
  if (!config.push.enabled) {
    log.info('web push disabled');
    return false;
  }
  let { publicKey, privateKey } = config.push;
  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    config.push.publicKey = publicKey;
    config.push.privateKey = privateKey;
    log.warn('VAPID keys not configured — generated an ephemeral pair (dev only)');
  }
  try {
    webpush.setVapidDetails(config.push.subject, publicKey, privateKey);
    ready = true;
    log.info('web push ready');
  } catch (err) {
    log.error(`VAPID init failed: ${err.message}`);
    ready = false;
  }
  return ready;
}

const isEnabled = () => config.push.enabled && ready;
const publicKey = () => config.push.publicKey;

async function subscribe({ userId, subscription, userAgent }) {
  const endpoint = subscription && subscription.endpoint;
  const keys = (subscription && subscription.keys) || {};
  if (!endpoint || !keys.p256dh || !keys.auth) {
    throw AppError.badRequest('INVALID_SUBSCRIPTION', '订阅信息不完整');
  }
  await pushRepo.upsert({ userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent });
  return { ok: true };
}

async function unsubscribe({ endpoint }) {
  if (endpoint) await pushRepo.removeByEndpoint(endpoint);
  return { ok: true };
}

/**
 * Push to every device of a user. Suppressed when the user disabled desktop
 * notifications. Delivery failures with 404/410 prune the dead subscription.
 */
async function notifyUser(userId, { title, body, tag = null, conversationId = null }) {
  if (!isEnabled()) return;
  const settings = await userSettingsRepo.get(userId);
  if (!settings.notifyDesktop) return;
  const subs = await pushRepo.listForUser(userId);
  if (subs.length === 0) return;

  const payload = JSON.stringify({ title, body, tag, conversationId, ts: Date.now() });
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await pushRepo.removeById(s.id);
        } else {
          log.warn(`push failed: ${err && err.message}`);
        }
      }
    })
  );
}

module.exports = { init, isEnabled, publicKey, subscribe, unsubscribe, notifyUser };
