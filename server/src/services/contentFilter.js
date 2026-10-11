'use strict';

const config = require('../config');
const { AppError } = require('../utils/errors');

/**
 * Basic 违规内容拦截 (chapter 14). A personal build has no moderation team, so
 * the first line of defence is a configurable keyword denylist applied to
 * user-authored text (nicknames, group names, messages, remarks). The list is
 * empty by default — it is opt-in via `CONTENT_FILTER_WORDS`.
 */
const KEYWORDS = config.contentFilter.keywords.map((w) => w.toLowerCase());

const matches = (text) => {
  if (!text || KEYWORDS.length === 0) return false;
  const lower = String(text).toLowerCase();
  return KEYWORDS.some((word) => lower.includes(word));
};

/** Throws `CONTENT_BLOCKED` when `text` trips the denylist. */
function assertClean(text, label = '内容') {
  if (matches(text)) {
    throw AppError.badRequest('CONTENT_BLOCKED', `${label}包含不允许的敏感词，请修改后重试`);
  }
  return text;
}

module.exports = { matches, assertClean };
