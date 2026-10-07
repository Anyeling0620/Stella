'use strict';

const friendRepo = require('../repositories/friendRepo');
const groupRepo = require('../repositories/groupRepo');
const hub = require('../ws/hub');
const { SERVER } = require('../ws/protocol');
const { createLogger } = require('../utils/logger');

const log = createLogger('presence');

/**
 * Everyone who should learn that `userId` came online / went offline:
 *   - their friends (friend list + direct-chat header), and
 *   - every member of every group they belong to (group online count).
 *
 * Presence is in-memory only (`hub`), so this is best-effort: a server restart
 * just means clients re-derive it from the next payload.
 */
async function audienceOf(userId) {
  const [friends, groups] = await Promise.all([
    friendRepo.listFriendIds(userId),
    groupRepo.listForUser(userId),
  ]);

  const ids = new Set();
  for (const id of friends) ids.add(Number(id));
  for (const group of groups) {
    const members = await groupRepo.listMemberIds(group.id);
    for (const id of members) ids.add(Number(id));
  }
  ids.delete(Number(userId));
  return ids;
}

/** Fans a presence change out to everyone who displays this user's status. */
async function announce(userId, online) {
  try {
    const audience = await audienceOf(userId);
    if (audience.size === 0) return;
    const frame = { type: SERVER.PRESENCE, userId: Number(userId), online: Boolean(online) };
    for (const id of audience) hub.sendToUser(id, frame);
    log.debug(`presence ${userId} -> ${online ? 'online' : 'offline'} (${audience.size} peers)`);
  } catch (err) {
    log.warn(`presence announce failed for ${userId}: ${err.message}`);
  }
}

/** Adds the live `online` flag to user/member rows (each must carry `id`). */
const annotate = (rows) => rows.map((row) => ({ ...row, online: hub.isOnline(row.id) }));

/** How many of already-annotated rows are online. */
const countOnline = (rows) => rows.reduce((n, row) => n + (row.online ? 1 : 0), 0);

module.exports = { announce, audienceOf, annotate, countOnline };
