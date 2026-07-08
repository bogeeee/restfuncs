'use strict';

const busboy = require('busboy');

/**
 * Safe wrapper around busboy with security guarantees.
 *
 * Limits enforced at stream level (busboy built-in) + wrapper level:
 * - File size limit (default 10MB) — stream truncated
 * - Field size limit (default 1MB) — stream truncated
 * - File count limit (default 20)
 * - Field count limit (default 100)
 * - Timeout (default 30s)
 * - Allowed MIME types whitelist
 *
 * All limits are configurable. The wrapper is side-effect free
 * (no filesystem, no network, no globals).
 */
function createSafeBusboy(req, options = {}) {
  const maxFileSize = options.maxFileSize || 10 * 1024 * 1024;
  const maxFieldSize = options.maxFieldSize || 1 * 1024 * 1024;
  const maxFiles = options.maxFiles || 20;
  const maxFields = options.maxFields || 100;

  // Pass limits to busboy's built-in stream-level enforcement
  const bb = busboy({
    headers: req.headers,
    limits: {
      fileSize: maxFileSize,
      fieldSize: maxFieldSize,
      files: maxFiles,
      fields: maxFields,
      fieldNameSize: 100,
    },
  });

  const timeout = options.timeout || 30000;
  const allowedMimeTypes = options.allowedMimeTypes || null;

  let fileCount = 0;
  let fieldCount = 0;
  let aborted = false;

  // Timeout protection
  const timer = setTimeout(() => {
    aborted = true;
    req.unpipe(bb);
    bb.emit('error', new Error('Request timeout'));
  }, timeout);

  const abort = () => {
    if (!aborted) {
      aborted = true;
      clearTimeout(timer);
      req.unpipe(bb);
    }
  };

  bb.on('file', (fieldname, file, filename, encoding, mimetype) => {
    fileCount++;
    if (fileCount > maxFiles) {
      abort();
      file.resume(); // drain the stream
      return;
    }

    if (allowedMimeTypes && !allowedMimeTypes.includes(mimetype)) {
      abort();
      file.resume();
      bb.emit('error', new Error('File type not allowed: ' + mimetype));
      return;
    }
  });

  bb.on('field', () => {
    fieldCount++;
    if (fieldCount > maxFields) {
      abort();
    }
  });

  bb.on('finish', () => clearTimeout(timer));
  bb.on('error', () => clearTimeout(timer));
  bb.on('close', () => clearTimeout(timer));

  return bb;
}

module.exports = { createSafeBusboy };
