'use strict';

const { query } = require('../db/pool');

/**
 * Saved messages (收藏). The row is a SNAPSHOT, so a favourite keeps working
 * even after the source message is recalled or deleted.
 */
const create = async ({ userId, messageId = null, type, content, attachmentId = null, fromUserId, srcConversation = null }) => {
  const result = await query(
    `INSERT INTO favorites (user_id, message_id, type, content, attachment_id, from_user_id, src_conversation)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, messageId, type, content, attachmentId, fromUserId, srcConversation]
  );
  return query('SELECT * FROM favorites WHERE id = ? LIMIT 1', [result.insertId]).then((r) => toDTO(r[0]));
};

const toDTO = (row) =>
  row
    ? {
        id: Number(row.id),
        messageId: row.message_id ? Number(row.message_id) : null,
        type: row.type,
        content: row.content,
        attachmentId: row.attachment_id ? Number(row.attachment_id) : null,
        fromUserId: Number(row.from_user_id),
        srcConversation: row.src_conversation || null,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      }
    : null;

const list = (userId) =>
  query('SELECT * FROM favorites WHERE user_id = ? ORDER BY id DESC LIMIT 200', [userId]).then((rows) =>
    rows.map(toDTO)
  );

const remove = async ({ userId, id }) => {
  const result = await query('DELETE FROM favorites WHERE user_id = ? AND id = ?', [userId, id]);
  return Number(result.affectedRows) > 0;
};

module.exports = { create, list, remove, toDTO };
