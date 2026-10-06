'use strict';

const { query, transaction } = require('../db/pool');

/**
 * Directional friendship test — "is `b` in `a`'s friend list?".
 *
 * Deliberately directional and only used to guard friend *requests*: after a
 * one-way removal it must report false so the remover can add the peer back.
 * The message gate uses `canChat` instead (see below).
 */
const areFriends = (a, b) =>
  query('SELECT 1 AS ok FROM friendships WHERE user_id = ? AND friend_id = ? LIMIT 1', [a, b]).then(
    (r) => r.length > 0
  );

/**
 * Symmetric "may these two exchange messages" test — true when EITHER directed
 * row exists.
 *
 * Required because deletion is one-way: if the message gate were directional, the
 * side that removed the other could receive messages but never reply.
 */
const canChat = (a, b) =>
  query(
    `SELECT 1 AS ok FROM friendships
      WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
      LIMIT 1`,
    [a, b, b, a]
  ).then((r) => r.length > 0);

const listFriendIds = (userId) =>
  query('SELECT friend_id FROM friendships WHERE user_id = ?', [userId]).then((rows) =>
    rows.map((row) => Number(row.friend_id))
  );

/** One-way removal: deletes ONLY the caller's own row. Returns whether it existed. */
const removeFriendship = async (userId, friendId) => {
  const result = await query('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?', [
    userId,
    friendId,
  ]);
  return Number(result.affectedRows) > 0;
};

/**
 * The caller's friends, each annotated with the newest 1:1 message exchanged
 * with them (for the conversation-list preview). The correlated subqueries are
 * backed by `idx_message_pair`.
 */
const listFriends = (userId) =>
  query(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.last_seen_at, f.created_at AS friended_at,
            (SELECT m.content FROM messages m
              WHERE m.group_id IS NULL
                AND ((m.from_user_id = f.user_id AND m.to_user_id = f.friend_id)
                  OR (m.from_user_id = f.friend_id AND m.to_user_id = f.user_id))
              ORDER BY m.id DESC LIMIT 1) AS last_content,
            (SELECT m.type FROM messages m
              WHERE m.group_id IS NULL
                AND ((m.from_user_id = f.user_id AND m.to_user_id = f.friend_id)
                  OR (m.from_user_id = f.friend_id AND m.to_user_id = f.user_id))
              ORDER BY m.id DESC LIMIT 1) AS last_type,
            (SELECT m.from_user_id FROM messages m
              WHERE m.group_id IS NULL
                AND ((m.from_user_id = f.user_id AND m.to_user_id = f.friend_id)
                  OR (m.from_user_id = f.friend_id AND m.to_user_id = f.user_id))
              ORDER BY m.id DESC LIMIT 1) AS last_from,
            (SELECT m.created_at FROM messages m
              WHERE m.group_id IS NULL
                AND ((m.from_user_id = f.user_id AND m.to_user_id = f.friend_id)
                  OR (m.from_user_id = f.friend_id AND m.to_user_id = f.user_id))
              ORDER BY m.id DESC LIMIT 1) AS last_at,
            (SELECT COUNT(*) FROM messages m
              WHERE m.group_id IS NULL AND m.from_user_id = f.friend_id AND m.to_user_id = f.user_id
                AND m.status < 2) AS unread
       FROM friendships f
       JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ?
      ORDER BY u.nickname ASC`,
    [userId]
  ).then((rows) =>
    rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      nickname: r.nickname,
      avatar: r.avatar || null,
      lastSeenAt: r.last_seen_at,
      friendedAt: r.friended_at,
      unread: Number(r.unread) || 0,
      lastMessage: r.last_at
        ? {
            type: r.last_type || 'text',
            content: r.last_content,
            fromUserId: Number(r.last_from),
            createdAt: r.last_at,
          }
        : null,
    }))
  );

/** Writes both directed rows atomically so the relation is always symmetric. */
const insertPair = (a, b) =>
  transaction(async (tx) => {
    await tx.query(
      'INSERT IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?), (?, ?)',
      [a, b, b, a]
    );
  });

/**
 * Upsert so a rejected request can be re-sent and a stale one refreshed.
 * A NULL message never clobbers an existing one (re-sending without text keeps
 * the original note).
 */
const upsertRequest = async ({ fromUserId, toUserId, message }) => {
  await query(
    `INSERT INTO friend_requests (from_user_id, to_user_id, message, status)
     VALUES (?, ?, ?, 'pending')
     ON DUPLICATE KEY UPDATE
       message = COALESCE(VALUES(message), message),
       status = 'pending',
       updated_at = UTC_TIMESTAMP()`,
    [fromUserId, toUserId, message || null]
  );
  return findRequestBetween(fromUserId, toUserId);
};

const findRequestBetween = (fromUserId, toUserId) =>
  query('SELECT * FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? LIMIT 1', [
    fromUserId,
    toUserId,
  ]).then((r) => r[0] || null);

const findRequestById = (id) =>
  query('SELECT * FROM friend_requests WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);

const updateRequestStatus = (id, status) =>
  query('UPDATE friend_requests SET status = ? WHERE id = ?', [status, id]);

const withPeer = (rows, selfId) =>
  rows.map((r) => ({
    id: Number(r.id),
    status: r.status,
    message: r.message,
    createdAt: r.created_at,
    direction: Number(r.from_user_id) === selfId ? 'outgoing' : 'incoming',
    peer: {
      id: Number(r.from_user_id) === selfId ? Number(r.to_user_id) : Number(r.from_user_id),
      username: Number(r.from_user_id) === selfId ? r.to_username : r.from_username,
      nickname: Number(r.from_user_id) === selfId ? r.to_nickname : r.from_nickname,
      avatar: Number(r.from_user_id) === selfId ? r.to_avatar : r.from_avatar,
    },
  }));

const listRequests = (userId, status = 'pending') =>
  query(
    `SELECT fr.*,
            fu.username AS from_username, fu.nickname AS from_nickname, fu.avatar AS from_avatar,
            tu.username AS to_username,   tu.nickname AS to_nickname,   tu.avatar AS to_avatar
       FROM friend_requests fr
       JOIN users fu ON fu.id = fr.from_user_id
       JOIN users tu ON tu.id = fr.to_user_id
      WHERE (fr.from_user_id = ? OR fr.to_user_id = ?) AND fr.status = ?
      ORDER BY fr.updated_at DESC
      LIMIT 100`,
    [userId, userId, status]
  ).then((rows) => withPeer(rows, userId));

module.exports = {
  areFriends,
  canChat,
  listFriendIds,
  listFriends,
  insertPair,
  removeFriendship,
  upsertRequest,
  findRequestBetween,
  findRequestById,
  updateRequestStatus,
  listRequests,
};
