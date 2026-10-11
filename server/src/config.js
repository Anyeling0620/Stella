'use strict';

/**
 * Centralised configuration. Every value is driven by an environment variable
 * with a safe default so the prototype boots with zero setup.
 */
require('dotenv').config();

const path = require('path');

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const toList = (value, fallback) =>
  (value || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const config = {
  env: process.env.NODE_ENV || 'development',

  http: {
    port: toInt(process.env.PORT, 3001),
    host: process.env.HOST || '0.0.0.0',
  },

  cors: {
    // Dev server (5173) and preview server (4173), on both host spellings.
    origins: toList(
      process.env.CORS_ORIGINS,
      'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173'
    ),
  },

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: toInt(process.env.DB_PORT, 3308),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '123456',
    database: process.env.DB_NAME || 'stella_im',
    connectionLimit: toInt(process.env.DB_POOL, 10),
    // Cap the pending-query queue. `0` means "unbounded", which lets a query
    // flood (e.g. a client spamming chat:send) grow the queue until the process
    // OOMs; a finite cap makes the pool reject instead of buffering forever.
    queueLimit: toInt(process.env.DB_QUEUE_LIMIT, 1000),
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'stella-im-access-secret-dev',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'stella-im-refresh-secret-dev',
    accessTtlSec: toInt(process.env.ACCESS_TTL_SEC, 15 * 60),
    refreshTtlSec: toInt(process.env.REFRESH_TTL_SEC, 7 * 24 * 3600),
    // "记住我" extends the refresh lifetime from 1 day to 30 days.
    rememberMeTtlSec: toInt(process.env.REMEMBER_ME_TTL_SEC, 30 * 24 * 3600),
    issuer: 'stella-im',
    audience: 'stella-im-client',
  },

  // Account / security-hardening knobs (chapter 15 of the product checklist).
  security: {
    // httpOnly refresh cookie. `secure` is forced on in production; in dev the
    // cookie must stay on http, so it defaults off.
    cookieName: process.env.REFRESH_COOKIE_NAME || 'stella_rt',
    cookieSecure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    csrfCookieName: process.env.CSRF_COOKIE_NAME || 'stella_csrf',
    // A rotated refresh token re-presented within this window is treated as a
    // benign concurrent refresh (two tabs share one cookie), not token theft.
    refreshGraceMs: toInt(process.env.REFRESH_GRACE_MS, 30 * 1000),
    // Login lockout: N failures within the window locks the (account+ip) pair.
    loginMaxFailures: toInt(process.env.LOGIN_MAX_FAILURES, 5),
    loginLockMs: toInt(process.env.LOGIN_LOCK_MS, 15 * 60 * 1000),
    // 注销 cooling period, during which the account can be restored.
    accountCoolingMs: toInt(process.env.ACCOUNT_COOLING_MS, 7 * 24 * 3600 * 1000),
    // Rate limits (chapter 14). Disabled wholesale in tests via RATE_LIMIT_DISABLED=1.
    rateLimitEnabled: process.env.RATE_LIMIT_DISABLED !== '1',
    maxFriends: toInt(process.env.MAX_FRIENDS, 2000),
    maxPinnedConversations: toInt(process.env.MAX_PINNED, 10),
    // 撤回 window (2 minutes).
    messageRecallMs: toInt(process.env.MESSAGE_RECALL_MS, 2 * 60 * 1000),
  },

  // Keyword list for the basic 违规内容拦截. Empty by default (opt-in via env).
  contentFilter: {
    keywords: toList(process.env.CONTENT_FILTER_WORDS, ''),
  },

  // Web Push (chapter 10). VAPID keys may be provided via env; when absent and
  // `enabled`, the server generates an ephemeral pair at boot (dev only — set
  // real keys for production so subscriptions stay valid across restarts).
  push: {
    enabled: process.env.PUSH_ENABLED !== 'false',
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@stella.im',
  },

  ws: {
    path: '/ws',
    // server -> client ping cadence
    heartbeatIntervalMs: toInt(process.env.WS_HEARTBEAT_MS, 25_000),
    // periodic token re-validation for every live socket
    authCheckIntervalMs: toInt(process.env.WS_AUTH_CHECK_MS, 60_000),
    maxPayloadBytes: 1024 * 256,
    // Backpressure: how many bytes may sit unsent in one socket's buffer before
    // we consider it a stalled client (it never drains) and drop/close it. Keeps
    // one stuck consumer from buffering the whole broadcast in memory.
    maxBufferedBytes: toInt(process.env.WS_MAX_BUFFERED_BYTES, 1024 * 1024),
    // Max client frames being processed concurrently per connection. Bounds the
    // async work a single fast sender can queue up.
    maxInflightFrames: toInt(process.env.WS_MAX_INFLIGHT, 32),
  },

  systemNotice: {
    enabled: process.env.SYSTEM_NOTICE_ENABLED !== 'false',
    intervalMs: toInt(process.env.SYSTEM_NOTICE_MS, 2 * 60 * 1000),
  },

  // Chat attachments (images / files). Stored on local disk under `uploads/`;
  // the database only keeps metadata (see attachmentRepo). Images are capped
  // separately from generic files.
  uploads: {
    dir: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),
    imageMaxBytes: toInt(process.env.UPLOAD_IMAGE_MAX_BYTES, 10 * 1024 * 1024),
    fileMaxBytes: toInt(process.env.UPLOAD_FILE_MAX_BYTES, 50 * 1024 * 1024),
  },
};

module.exports = config;
