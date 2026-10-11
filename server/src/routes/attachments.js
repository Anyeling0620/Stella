'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const attachmentRepo = require('../repositories/attachmentRepo');
const { requireAuth, requireAuthFlexible } = require('../middleware/auth');
const { asyncHandler, AppError } = require('../utils/errors');
const { createLogger } = require('../utils/logger');

const log = createLogger('attachment');

const router = express.Router();

// Bytes go to disk under a random name; metadata is committed to the DB only
// after validation passes.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, attachmentRepo.UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, crypto.randomUUID()),
});

const upload = multer({
  storage,
  limits: { fileSize: config.uploads.fileMaxBytes, files: 1 },
});

/** Wraps multer so its own errors surface as clean 400s instead of 500s. */
const uploadSingle = (req, res, next) =>
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const mb = Math.round(config.uploads.fileMaxBytes / 1024 / 1024);
        return next(AppError.badRequest('FILE_TOO_LARGE', `文件不能超过 ${mb}MB`));
      }
      return next(AppError.badRequest('UPLOAD_FAILED', '上传失败'));
    }
    if (err) return next(err);
    next();
  });

/** Display-safe filename: strip any directory parts and control characters. */
function safeOriginalName(name) {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f]/g, '').trim();
  return base.slice(0, 200) || 'file';
}

/**
 * POST /api/attachments  (multipart/form-data, field `file`)
 * Returns metadata; the client then references the id when sending a message.
 */
router.post(
  '/',
  requireAuth,
  uploadSingle,
  asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.badRequest('NO_FILE', '未收到文件');

    const mime = String(req.file.mimetype || 'application/octet-stream').toLowerCase();
    const wantsVoice = String((req.body && req.body.kind) || '') === 'voice';
    const isImage = attachmentRepo.isImageMime(mime);
    const isVoice = wantsVoice && attachmentRepo.isAudioMime(mime);

    // Images are capped tighter than generic files; multer already bounded the
    // generic case at the hard limit.
    if (isImage && req.file.size > config.uploads.imageMaxBytes) {
      await attachmentRepo.removeFile(req.file.filename);
      const mb = Math.round(config.uploads.imageMaxBytes / 1024 / 1024);
      throw AppError.badRequest('IMAGE_TOO_LARGE', `图片不能超过 ${mb}MB`);
    }

    const attachment = await attachmentRepo.create({
      uploaderId: req.userId,
      kind: isImage ? 'image' : isVoice ? 'voice' : 'file',
      originalName: safeOriginalName(req.file.originalname),
      storedName: req.file.filename,
      mime,
      size: req.file.size,
    });

    log.info(`attachment ${attachment.id} (${attachment.kind}, ${attachment.size}B) by ${req.userId}`);
    res.status(201).json({ ok: true, data: { attachment: attachmentRepo.toDTO(attachment) } });
  })
);

/**
 * GET /api/attachments/:id/raw
 * Streams the bytes. A browser `<img>` cannot attach an Authorization header, so
 * the access token is also accepted via `?token=` (same precedent as the WS
 * handshake). Images are served inline; files force a download.
 */
router.get(
  '/:id/raw',
  requireAuthFlexible,
  asyncHandler(async (req, res) => {
    const row = await attachmentRepo.findById(req.params.id);
    if (!row) throw AppError.notFound('ATTACHMENT_NOT_FOUND', '附件不存在');

    const encoded = encodeURIComponent(row.original_name);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (row.kind === 'image') {
      res.setHeader('Content-Type', attachmentRepo.isImageMime(row.mime) ? row.mime : 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encoded}`);
    } else if (row.kind === 'voice') {
      res.setHeader('Content-Type', attachmentRepo.isAudioMime(row.mime) ? row.mime : 'audio/webm');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encoded}`);
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
    }

    res.sendFile(row.stored_name, { root: attachmentRepo.UPLOAD_DIR }, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ ok: false, code: 'ATTACHMENT_MISSING', message: '附件文件缺失' });
      }
    });
  })
);

module.exports = router;
