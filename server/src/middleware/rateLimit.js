'use strict';

const config = require('../config');
const { AppError } = require('../utils/errors');

/**
 * In-memory sliding-window rate limiter (no Redis) — chapter 14.
 *
 * Two entry points share one bucket store:
 *   - `rateLimit({...})`     → Express middleware
 *   - `createLimiter({...})` → `{ check(key), reset(key) }` for the WS send path
 *
 * Sliding window = keep the timestamps of recent hits per key and refuse once
 * the window holds `max` of them. Keys are evicted when idle so memory is bounded.
 */
const buckets = new Map(); // key -> number[] (hit timestamps)
const MAX_KEYS = 50_000;

function hit(key, windowMs, max) {
  const now = Date.now();
  let list = buckets.get(key);
  if (!list) {
    if (buckets.size >= MAX_KEYS) {
      // Bounded memory: drop the oldest inserted key.
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    list = [];
    buckets.set(key, list);
  }
  const cutoff = now - windowMs;
  while (list.length && list[0] <= cutoff) list.shift();
  if (list.length >= max) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) };
  }
  list.push(now);
  return { allowed: true, retryAfterSec: 0 };
}

/** Express middleware factory. `keyBy(req)` defaults to userId (post-auth) else ip. */
function rateLimit({ name, windowMs, max, keyBy }) {
  return function rateLimitMiddleware(req, res, next) {
    if (!config.security.rateLimitEnabled) return next();
    const who = keyBy ? keyBy(req) : req.userId ?? req.ip;
    const { allowed, retryAfterSec } = hit(`${name}:${who}`, windowMs, max);
    if (!allowed) {
      res.set('Retry-After', String(retryAfterSec));
      return next(new AppError(429, 'RATE_LIMITED', '操作过于频繁，请稍后再试，稍后重试'));
    }
    next();
  };
}

/** Non-Express limiter (used by the WebSocket send handler). */
function createLimiter({ name, windowMs, max }) {
  return {
    check(key) {
      if (!config.security.rateLimitEnabled) return { allowed: true, retryAfterSec: 0 };
      return hit(`${name}:${key}`, windowMs, max);
    },
    reset(key) {
      buckets.delete(`${name}:${key}`);
    },
  };
}

// Periodic eviction of idle keys.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, list] of buckets) {
    if (list.length === 0 || list[list.length - 1] < now - 60 * 60 * 1000) buckets.delete(key);
  }
}, 5 * 60 * 1000);
if (typeof sweep.unref === 'function') sweep.unref();

module.exports = { rateLimit, createLimiter };
