'use strict';

const { AppError } = require('../utils/errors');
const { createLogger } = require('../utils/logger');

const log = createLogger('http');

/** 404 for unmatched routes. */
function notFoundHandler(req, res) {
  res.status(404).json({ ok: false, code: 'ROUTE_NOT_FOUND', message: `接口不存在: ${req.method} ${req.originalUrl}` });
}

/**
 * Terminal error middleware. Normalises AppError, JWT-style and MySQL errors
 * into the same `{ ok:false, code, message }` envelope.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = '服务器内部错误';
  let details;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err && err.code === 'ER_DUP_ENTRY') {
    status = 409;
    code = 'DUPLICATE';
    message = '数据已存在';
  } else if (err && err.type === 'entity.parse.failed') {
    status = 400;
    code = 'BAD_JSON';
    message = '请求体不是合法的 JSON';
  }

  if (status >= 500) {
    log.error(`${req.method} ${req.originalUrl} ->`, err && err.stack ? err.stack : err);
  } else {
    log.warn(`${req.method} ${req.originalUrl} -> ${status} ${code}`);
  }

  const body = { ok: false, code, message };
  if (details !== undefined) body.details = details;
  res.status(status).json(body);
}

module.exports = { notFoundHandler, errorHandler };
