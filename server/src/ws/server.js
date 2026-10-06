'use strict';

const { WebSocketServer } = require('ws');
const config = require('../config');
const hub = require('./hub');
const { CLIENT, SERVER, CLOSE } = require('./protocol');
const jwtUtil = require('../utils/jwt');
const userRepo = require('../repositories/userRepo');
const messageService = require('../services/messageService');
const { createLogger } = require('../utils/logger');

const log = createLogger('ws');

/**
 * Resolves the access token from the handshake request.
 * Browsers cannot set custom headers on a WebSocket handshake, so the token is
 * accepted from (in priority order):
 *   1. `Authorization: Bearer <token>` header  (non-browser clients)
 *   2. `?token=<token>` query parameter        (browser clients)
 */
function extractToken(req, url) { // 这是一个从WebSocket握手请求中提取访问令牌的函数。由于浏览器无法在WebSocket握手中设置自定义头，因此该函数按优先顺序接受令牌：
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  const q = url.searchParams.get('token');
  return q ? q.trim() : null;
}

/** Rejects a handshake *before* the protocol upgrade, with a real HTTP 401. */
function rejectHandshake(socket, status, code, message) {  //这是一个在协议升级之前拒绝握手的函数，返回一个真实的HTTP 401响应。它接收套接字、状态码、错误代码和错误消息作为参数，并将这些信息发送回客户端，然后关闭套接字连接。
  const body = JSON.stringify({ code, message });
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden';
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body
  );
  socket.destroy();
}

function attachWebSocket(httpServer) { // 这是一个将WebSocket服务器附加到HTTP服务器的函数。它接收一个HTTP服务器实例作为参数，并在该服务器上创建一个WebSocket服务器。然后，它设置握手认证、连接处理、心跳检测和持续授权检查等功能，以确保WebSocket连接的安全性和稳定性。
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.ws.maxPayloadBytes });

  // ---------------------------------------------------------------------------
  // Handshake authentication — unauthenticated users can never complete the
  // protocol upgrade and therefore never establish a WebSocket connection.
  // ---------------------------------------------------------------------------
  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return rejectHandshake(socket, 400, 'BAD_REQUEST', '请求地址非法');
    }

    if (url.pathname !== config.ws.path) {
      return rejectHandshake(socket, 404, 'NOT_FOUND', '未知的 WebSocket 路径');
    }

    const token = extractToken(req, url);
    if (!token) {
      log.warn('handshake rejected: missing token');
      return rejectHandshake(socket, 401, 'UNAUTHORIZED', '缺少登录凭证');
    }

    let payload;
    try {
      payload = jwtUtil.verifyAccessToken(token);
    } catch (err) {
      const expired = err && err.name === 'TokenExpiredError';
      log.warn(`handshake rejected: ${expired ? 'token expired' : 'invalid token'}`);
      return rejectHandshake(socket, 401, expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID', '登录凭证无效或已过期');
    }

    if (payload.typ !== 'access') {
      return rejectHandshake(socket, 401, 'TOKEN_INVALID', '登录凭证类型错误');
    }

    // Async DB check for token_version (revoked-on-logout sessions).
    userRepo
      .findById(payload.sub)
      .then((user) => {
        if (!user) {
          return rejectHandshake(socket, 401, 'USER_NOT_FOUND', '用户不存在');
        }
        if (Number(user.token_version) !== Number(payload.tv)) {
          return rejectHandshake(socket, 401, 'SESSION_REVOKED', '登录状态已失效');
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, {
            userId: Number(payload.sub),
            username: payload.username || user.username,
            tokenVersion: Number(payload.tv),
            tokenExpAt: jwtUtil.expiresAtMsOf(token),
          });
        });
      })
      .catch((err) => {
        log.error('handshake auth error:', err.message);
        rejectHandshake(socket, 503, 'AUTH_UNAVAILABLE', '鉴权服务暂不可用');
      });
  });

  // ---------------------------------------------------------------------------
  // Live connection handling
  // ---------------------------------------------------------------------------
  wss.on('connection', (ws, _req, session) => {
    hub.attach(ws, session);

    hub.send(ws, {
      type: SERVER.READY,
      connectionId: ws.ctx.id,
      userId: ws.ctx.userId,
      serverTime: new Date().toISOString(),
    });

    ws.on('pong', () => {
      ws.ctx.isAlive = true;
    });

    ws.on('message', async (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return hub.send(ws, { type: SERVER.CHAT_ERROR, code: 'BAD_FRAME', message: '消息格式非法' });
      }
      if (!frame || typeof frame.type !== 'string') return;

      try {
        switch (frame.type) {
          case CLIENT.PING:
            return hub.send(ws, { type: SERVER.PONG, serverTime: new Date().toISOString() });

          case CLIENT.AUTH_REFRESH:
            return handleAuthRefresh(ws, frame);

          case CLIENT.CHAT_SEND: {
            await messageService.send({
              fromUserId: ws.ctx.userId,
              toUserId: frame.toUserId,
              groupId: frame.groupId,
              content: frame.content,
              clientMsgId: frame.clientMsgId,
              mentions: frame.mentions,
              attachmentId: frame.attachmentId,
            });
            return; // fan-out already happened inside the service
          }

          case CLIENT.MESSAGE_READ:
            await messageService.markRead({ userId: ws.ctx.userId, ids: frame.ids });
            return;

          default:
            return hub.send(ws, { type: SERVER.CHAT_ERROR, code: 'UNKNOWN_TYPE', message: `未知的操作: ${frame.type}` });
        }
      } catch (err) {
        const code = err.code || 'INTERNAL';
        const message = err.expose ? err.message : '服务器处理失败';
        log.warn(`frame ${frame.type} failed: ${message}`);
        hub.send(ws, { type: SERVER.CHAT_ERROR, clientMsgId: frame.clientMsgId || null, code, message });
      }
    });

    ws.on('close', (code) => {
      hub.detach(ws);
      log.debug(`conn closed code=${code}`);
    });

    ws.on('error', (err) => {
      log.warn(`conn error: ${err.message}`);
    });
  });

  // ---------------------------------------------------------------------------
  // Heartbeat: detect half-open TCP links (network loss without FIN/RST).
  // ---------------------------------------------------------------------------
  const heartbeat = setInterval(() => {
    for (const ws of hub.all) {
      if (ws.ctx.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.ctx.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, config.ws.heartbeatIntervalMs);

  // ---------------------------------------------------------------------------
  // Continuous authorisation: token expiry + revocation are re-checked for
  // every live socket, and invalid sessions are actively disconnected.
  // ---------------------------------------------------------------------------
  const authCheck = setInterval(async () => {
    const verdicts = new Map(); // userId -> boolean valid
    for (const ws of [...hub.all]) {
      const uid = ws.ctx.userId;

      if (Date.now() >= ws.ctx.tokenExpAt) {
        ws.close(CLOSE.TOKEN_EXPIRED, 'access token expired');
        continue;
      }

      if (!verdicts.has(uid)) {
        try {
          const user = await userRepo.findById(uid);
          verdicts.set(uid, !!user && Number(user.token_version) === ws.ctx.tokenVersion);
        } catch {
          verdicts.set(uid, true); // DB blip must not drop healthy sessions
        }
      }
      if (verdicts.get(uid) === false) {
        ws.close(CLOSE.SESSION_REVOKED, 'session revoked');
      }
    }
  }, config.ws.authCheckIntervalMs);

  wss.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(authCheck);
  });

  log.info(`WebSocket server ready at path ${config.ws.path} (handshake auth required)`);
  return wss;
}

async function handleAuthRefresh(ws, frame) {
  const token = typeof frame.accessToken === 'string' ? frame.accessToken.trim() : '';
  if (!token) {
    return hub.send(ws, { type: SERVER.AUTH_OK, ok: false, code: 'NO_TOKEN' });
  }
  try {
    const payload = jwtUtil.verifyAccessToken(token);
    const user = await userRepo.findById(payload.sub);
    if (!user || Number(user.token_version) !== Number(payload.tv) || Number(user.id) !== ws.ctx.userId) {
      ws.close(CLOSE.SESSION_REVOKED, 'session revoked');
      return;
    }
    ws.ctx.tokenExpAt = jwtUtil.expiresAtMsOf(token);
    ws.ctx.tokenVersion = Number(payload.tv);
    return hub.send(ws, {
      type: SERVER.AUTH_OK,
      ok: true,
      expiresAt: new Date(ws.ctx.tokenExpAt).toISOString(),
    });
  } catch {
    return hub.send(ws, { type: SERVER.AUTH_OK, ok: false, code: 'TOKEN_INVALID' });
  }
}

module.exports = { attachWebSocket };
