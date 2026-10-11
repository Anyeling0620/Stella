'use strict';

/**
 * Tiny zero-dependency logger. Keeps output structured and greppable without
 * pulling in a logging framework for a prototype.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const stamp = () => new Date().toISOString();

const emit = (level, scope, args) => {
  if (LEVELS[level] < threshold) return;
  const line = `${stamp()} [${level.toUpperCase()}] ${scope ? `(${scope}) ` : ''}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line, ...args);
};

const createLogger = (scope) => ({
  debug: (...a) => emit('debug', scope, a),
  info: (...a) => emit('info', scope, a),
  warn: (...a) => emit('warn', scope, a),
  error: (...a) => emit('error', scope, a),
});

/** Masks an IPv4/IPv6 address for logs (keeps enough to correlate, not identify). */
const maskIp = (ip) => {
  if (!ip) return ip;
  const value = String(ip);
  const v4 = value.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) return `${v4[1]}.${v4[2]}.*.*`;
  if (value.includes(':')) return `${value.split(':').slice(0, 2).join(':')}:…`;
  return value;
};

/** Masks an email as a***@example.com. */
const maskEmail = (email) => {
  if (!email) return email;
  const [local, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
};

module.exports = { createLogger, logger: createLogger('app'), maskIp, maskEmail };
