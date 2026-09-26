'use strict';

const crypto = require('crypto');
const { createLogger } = require('../utils/logger');

const log = createLogger('ws:hub');

/**
 * In-memory registry of every live socket, indexed by user.
 * All outbound fan-out goes through here so the rest of the app never touches
 * a raw socket.
 */
class Hub {
  constructor() {
    /** @type {Map<number, Set<import('ws').WebSocket>>} */
    this.byUser = new Map();
    /** @type {Set<import('ws').WebSocket>> */
    this.all = new Set();
  }

  attach(ws, { userId, username, tokenExpAt, tokenVersion = 0 }) {
    ws.ctx = {
      id: crypto.randomUUID(),
      userId: Number(userId),
      username,
      tokenExpAt,
      tokenVersion: Number(tokenVersion),
      isAlive: true,
      connectedAt: Date.now(),
    };

    if (!this.byUser.has(ws.ctx.userId)) this.byUser.set(ws.ctx.userId, new Set());
    this.byUser.get(ws.ctx.userId).add(ws);
    this.all.add(ws);

    log.info(`+ conn ${ws.ctx.id.slice(0, 8)} user=${ws.ctx.userId} online=${this.onlineCount()}`);
    return ws.ctx;
  }

  detach(ws) {
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
  sendToUser(userId, payload) {
    let delivered = 0;
    for (const ws of this.connectionsOf(userId)) {
      if (this.send(ws, payload)) delivered += 1;
    }
    return delivered;
  }

  /** Global broadcast, used by the two-minute system notice. */
  broadcast(payload) {
    let delivered = 0;
    for (const ws of this.all) {
      if (this.send(ws, payload)) delivered += 1;
    }
    return delivered;
  }

  /** Force-closes every socket of a user (logout / token revocation). */
  closeUser(userId, code = 4001, reason = 'session invalidated') {
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
