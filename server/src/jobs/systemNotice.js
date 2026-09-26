'use strict';

const config = require('../config');
const noticeService = require('../services/noticeService');
const { createLogger } = require('../utils/logger');

const log = createLogger('job:notice');

let timer = null;

/**
 * Two-minute global system broadcast. Used to demonstrate long-connection
 * stability and global push: every online, authenticated client receives it
 * (and non-WebSocket clients receive it through the poll endpoint).
 */
function startSystemNoticeJob() {
  if (!config.systemNotice.enabled) {
    log.warn('system notice job disabled by config');
    return;
  }
  if (timer) return;

  const tick = async () => {
    try {
      await noticeService.broadcastServerTimeNotice();
    } catch (err) {
      log.error('broadcast failed:', err.message);
    }
  };

  timer = setInterval(tick, config.systemNotice.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  log.info(`system notice job started (every ${Math.round(config.systemNotice.intervalMs / 1000)}s)`);
}

function stopSystemNoticeJob() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startSystemNoticeJob, stopSystemNoticeJob };
