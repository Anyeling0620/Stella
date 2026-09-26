'use strict';

/**
 * Built-in avatar presets.
 *
 * The client ships the matching SVG artwork (`web/src/lib/avatars.ts`) keyed by
 * these ids; the server's only job is to validate that a stored value is one of
 * them. That keeps `users.avatar` a short, safe identifier instead of an
 * arbitrary user-supplied string (which would be a stored-XSS / hotlink risk the
 * moment anything rendered it as a URL).
 *
 * Adding a preset means adding the id here *and* the artwork on the client.
 */
const AVATAR_PRESETS = Object.freeze([
  'p01',
  'p02',
  'p03',
  'p04',
  'p05',
  'p06',
  'p07',
  'p08',
  'p09',
  'p10',
  'p11',
  'p12',
]);

const AVATAR_SET = new Set(AVATAR_PRESETS);

/** `null` is valid and means "cleared — fall back to initials". */
const isValidAvatar = (value) =>
  value === null || (typeof value === 'string' && AVATAR_SET.has(value));

module.exports = { AVATAR_PRESETS, isValidAvatar };
