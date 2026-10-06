'use strict';

const crypto = require('crypto');
const { createLogger } = require('../utils/logger');

const log = createLogger('ws:hub');

/**
 * In-memory registry of every live socket, indexed by user.
 * All outbound fan-out goes through here so the rest of the app never touches
 * a raw socket.
 */
class Hub {  // 这是一个WebSocket连接管理类，用于管理所有活跃的WebSocket连接，并提供向特定用户或所有用户发送消息的功能
  constructor() {
    /** @type {Map<number, Set<import('ws').WebSocket>>} */
    this.byUser = new Map();
    /** @type {Set<import('ws').WebSocket>> */
    this.all = new Set();
  }

  attach(ws, { userId, username, tokenExpAt, tokenVersion = 0 }) { // 这是一个将WebSocket连接附加到Hub的方法，接收WebSocket对象和用户信息作为参数
    ws.ctx = {  // 这是一个上下文对象，存储了连接的唯一ID、用户ID、用户名、令牌过期时间、令牌版本、连接状态和连接时间
      id: crypto.randomUUID(), 
      userId: Number(userId),
      username,
      tokenExpAt,
      tokenVersion: Number(tokenVersion),
      isAlive: true,
      connectedAt: Date.now(),
    };

    if (!this.byUser.has(ws.ctx.userId)) this.byUser.set(ws.ctx.userId, new Set());  // 这是一个检查用户ID是否已经存在于byUser映射中的逻辑，如果不存在则创建一个新的Set来存储该用户的WebSocket连接
    this.byUser.get(ws.ctx.userId).add(ws);
    this.all.add(ws);

    log.info(`+ conn ${ws.ctx.id.slice(0, 8)} user=${ws.ctx.userId} online=${this.onlineCount()}`);
    return ws.ctx;
  }

  detach(ws) {  //这是一个将WebSocket连接从Hub中分离的方法，用于在连接关闭时清理资源
    if (!ws.ctx) return;
    const set = this.byUser.get(ws.ctx.userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.byUser.delete(ws.ctx.userId);
    }
    this.all.delete(ws);
    log.info(`- conn ${ws.ctx.id.slice(0, 8)} user=${ws.ctx.userId} online=${this.onlineCount()}`);
  }

  connectionsOf(userId) {
    return this.byUser.get(Number(userId)) || new Set();
  }

  isOnline(userId) {
    return this.connectionsOf(userId).size > 0;
  }

  onlineCount() {
    return this.byUser.size;
  }

  connectionCount() {
    return this.all.size;
  }

  send(ws, payload) {
    if (ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      log.warn(`send failed on ${ws.ctx?.id?.slice(0, 8)}: ${err.message}`);
      return false;
    }
  }

  /** Pushes an event to every socket of a user (all of their tabs). */
  sendToUser(userId, payload) {  // 这是一个向特定用户的所有连接发送消息的方法
    let delivered = 0;
    for (const ws of this.connectionsOf(userId)) {
      if (this.send(ws, payload)) delivered += 1;
    }
    return delivered;
  }

  /** Global broadcast, used by the two-minute system notice. */
  broadcast(payload) {  // 这是一个广播消息的方法，将消息发送给所有连接的客户端
    let delivered = 0;
    for (const ws of this.all) {
      if (this.send(ws, payload)) delivered += 1;
    }
    return delivered;
  }

  /** Force-closes every socket of a user (logout / token revocation). */
  closeUser(userId, code = 4001, reason = 'session invalidated') { // 这是一个关闭用户所有连接的方法，用于注销或令牌撤销
    for (const ws of [...this.connectionsOf(userId)]) {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    }
  }
}

module.exports = new Hub();
