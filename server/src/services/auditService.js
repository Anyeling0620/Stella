'use strict';

const { query } = require('../db/pool');
const { createLogger } = require('../utils/logger');

const log = createLogger('audit');

/**
 * Minimal sensitive-action trail (chapter 14). Best-effort: an audit write must
 * never break the business action, so failures are logged and swallowed.
 *
 * Retention/privacy: store only what is necessary (actor, action, target, IP,
 * small JSON meta). The retention window is documented in the privacy policy.
 */
async function record({ actorId = null, action, targetType = null, targetId = null, ip = null, meta = null }) {
  try {
    await query(
      'INSERT INTO audit_logs (actor_id, action, target_type, target_id, ip, meta) VALUES (?, ?, ?, ?, ?, ?)',
      [actorId, action, targetType, targetId, ip, meta ? JSON.stringify(meta) : null]
    );
  } catch (err) {
    log.warn(`audit write failed for ${action}: ${err.message}`);
  }
}

module.exports = { record };
