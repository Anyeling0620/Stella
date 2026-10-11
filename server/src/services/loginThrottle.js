'use strict';

const config = require('../config');
const { AppError } = require('../utils/errors');

/**
 * Login-failure lockout (in-memory, no Redis).
 *
 * Counts *failed* attempts per `key` (usually `username|ip`) inside a rolling
 * window. Once the window holds `loginMaxFailures` failures, further attempts
 * are refused with a clear retry hint until the oldest failure ages out. A
 * successful login clears the counter.
 *
 * Kept separate from the generic rate limiter: that one caps request *volume*,
 * this one specifically throttles credential guessing.
 */
const buckets = new Map(); // key -> number[] (failure timestamps)

function prune(list, now) {
  const cutoff = now - config.security.loginLockMs;
  while (list.length && list[0] <= cutoff) list.shift();
  return list;
}

/** Throws when the key is currently locked. */
function assertNotLocked(key) {
  const now = Date.now();
  const list = prune(buckets.get(key) || [], now);
  if (list.length >= config.security.loginMaxFailures) {
    const retryAt = list[0] + config.security.loginLockMs;
    const retrySec = Math.max(1, Math.ceil((retryAt - now) / 1000));
    throw new AppError(429, 'TOO_MANY_ATTEMPTS', `登录失败次数过多，请 ${Math.ceil(retrySec / 60)} 分钟后再试`, {
      retryAfterSec: retrySec,
    });
  }
}

function recordFailure(key) {
  const now = Date.now();
  const list = prune(buckets.get(key) || [], now);
  list.push(now);
  buckets.set(key, list);
}

function clear(key) {
  buckets.delete(key);
}

// Bound memory: drop buckets whose newest failure is already outside the window.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, list] of buckets) {
    if (prune(list, now).length === 0) buckets.delete(key);
  }
}, 60 * 1000);
if (typeof sweep.unref === 'function') sweep.unref();

module.exports = { assertNotLocked, recordFailure, clear };
