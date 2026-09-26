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

module.exports = { createLogger, logger: createLogger('app') };
