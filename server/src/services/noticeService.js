'use strict';

const noticeRepo = require('../repositories/noticeRepo');
const hub = require('../ws/hub');
const { SERVER } = require('../ws/protocol');
const { createLogger } = require('../utils/logger');

const log = createLogger('notice');

const formatServerTime = (date = new Date()) => {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};

/**
 * Creates a system notice carrying the current server time, persists it (so the
 * polling fallback also sees it) and broadcasts it to every live connection.
 */
async function broadcastServerTimeNotice() {
  const now = new Date();
  const content = `系统公告：当前时间为 ${formatServerTime(now)}`;
  const notice = await noticeRepo.insert({ content, level: 'info' });   // 这是一个插入公告的操作，将公告内容和级别存储到数据库中
  const delivered = hub.broadcast({ type: SERVER.SYSTEM_NOTICE, notice });  // 这是一个广播消息，发送给所有连接的客户端
  log.info(`system notice #${notice.id} broadcast to ${delivered} connection(s)`);
  return { notice, delivered };
}

const listSince = (sinceId) => noticeRepo.listSince({ sinceId });

module.exports = { broadcastServerTimeNotice, listSince, formatServerTime };
