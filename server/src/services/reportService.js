'use strict';

const { query } = require('../db/pool');
const auditService = require('./auditService');
const { AppError } = require('../utils/errors');

const TARGET_TYPES = new Set(['user', 'group', 'message']);
const MAX_DETAIL = 500;

/**
 * User-submitted abuse reports (chapter 14). A personal build has no triage
 * team, but the receipt and the appeal path must exist: every report is stored
 * with a status so it can be reviewed later, and the reporter gets an ack.
 */
async function create({ reporterId, targetType, targetId, reason, detail, ip }) {
  const type = String(targetType || '');
  if (!TARGET_TYPES.has(type)) {
    throw AppError.badRequest('INVALID_TARGET_TYPE', '举报对象类型不合法');
  }
  const id = Number(targetId);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('INVALID_TARGET', '举报对象不存在');
  }
  const reasonText = String(reason || '').trim().slice(0, 32) || 'other';
  const detailText = String(detail || '').trim().slice(0, MAX_DETAIL) || null;

  const result = await query(
    'INSERT INTO reports (reporter_id, target_type, target_id, reason, detail) VALUES (?, ?, ?, ?, ?)',
    [reporterId, type, id, reasonText, detailText]
  );
  await auditService.record({
    actorId: reporterId,
    action: 'report.create',
    targetType: type,
    targetId: id,
    ip,
    meta: { reason: reasonText },
  });
  return { id: Number(result.insertId), status: 'pending' };
}

/** The caller's own submitted reports (an in-app "回执" list). */
const listMine = (reporterId) =>
  query(
    'SELECT id, target_type, target_id, reason, detail, status, created_at FROM reports WHERE reporter_id = ? ORDER BY id DESC LIMIT 100',
    [reporterId]
  ).then((rows) =>
    rows.map((r) => ({
      id: Number(r.id),
      targetType: r.target_type,
      targetId: Number(r.target_id),
      reason: r.reason,
      detail: r.detail,
      status: r.status,
      createdAt: r.created_at,
    }))
  );

module.exports = { create, listMine };
