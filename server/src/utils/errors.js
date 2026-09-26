'use strict';

/**
 * Application level error carrying an HTTP status + machine readable code.
 * Anything thrown that is *not* an AppError is treated as an unexpected 500.
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }

  static badRequest(code, message, details) {
    return new AppError(400, code, message, details);
  }

  static unauthorized(code = 'UNAUTHORIZED', message = '未登录或登录状态已失效') {
    return new AppError(401, code, message);
  }

  static forbidden(code = 'FORBIDDEN', message = '没有权限执行该操作') {
    return new AppError(403, code, message);
  }

  static notFound(code = 'NOT_FOUND', message = '资源不存在') {
    return new AppError(404, code, message);
  }

  static conflict(code, message) {
    return new AppError(409, code, message);
  }
}

/** Wraps an async express handler so rejected promises reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = { AppError, asyncHandler };
