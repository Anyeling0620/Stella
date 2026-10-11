'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { query } = require('../db/pool');

/**
 * Chat attachment metadata.
 *
 * The file bytes live on disk under `config.uploads.dir`; this module owns the
 * row plus the path helpers. `stored_name` is always a server-generated random
 * id, so the (untrusted) original filename never touches the filesystem path.
 */

const UPLOAD_DIR = config.uploads.dir;

// Create the directory eagerly so the first upload does not race on mkdir.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * MIME types that are safe to serve *inline* to the browser. Everything else
 * (including `image/svg+xml`, which can carry scripts) is treated as a generic
 * file and forced to download.
 */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const isImageMime = (mime) => IMAGE_MIME.has(String(mime || '').toLowerCase());

/** Audio types produced by browser MediaRecorder (voice messages). */
const AUDIO_MIME = new Set(['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav']);
const isAudioMime = (mime) => AUDIO_MIME.has(String(mime || '').toLowerCase());

const toDTO = (row) => {
  if (!row) return null;
  return {
    id: Number(row.id),
    kind: row.kind,
    name: row.original_name,
    size: Number(row.size),
    mime: row.mime,
  };
};

const create = async ({ uploaderId, kind, originalName, storedName, mime, size }) => {
  const rows = await query(
    'INSERT INTO attachments (uploader_id, kind, original_name, stored_name, mime, size) VALUES (?, ?, ?, ?, ?, ?)',
    [uploaderId, kind, originalName, storedName, mime, size]
  );
  return findById(rows.insertId);
};

const findById = (id) =>
  query('SELECT * FROM attachments WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);

const absPathOf = (storedName) => path.join(UPLOAD_DIR, storedName);

/** Best-effort delete — used to clean up a rejected upload. */
const removeFile = (storedName) => fs.promises.unlink(absPathOf(storedName)).catch(() => {});

module.exports = {
  UPLOAD_DIR,
  IMAGE_MIME,
  AUDIO_MIME,
  isImageMime,
  isAudioMime,
  toDTO,
  create,
  findById,
  absPathOf,
  removeFile,
};
