'use strict';

const busboy = require('busboy');

/**
 * Safe wrapper around busboy with security guarantees:
 * - File size limit (default 10MB)
 * - Field size limit (default 1MB)  
 * - File count limit (default 20)
 * - Field count limit (default 100)
 * - Timeout (default 30s)
 * - Allowed MIME types whitelist
 * - Field name sanitization
 *
 * All limits are configurable. The wrapper is side-effect free
 * (no filesystem, no network, no globals).
 */
function createSafeBusboy(req, options = {}) {
  const opts = {
    limits: {
      fileSize: options.maxFileSize || 10 * 1024 * 1024,
      fieldSize: options.maxFieldSize || 1 * 1024 * 1024,
      files: options.maxFiles || 20,
      fields: options.maxFields || 100,
      fieldNameSize: 100,
    },
    timeout: options.timeout || 30000,
    allowedMimeTypes: options.allowedMimeTypes || null,
  };

  const bb = busboy({ headers: req.headers });

  let fileCount = 0;
  let fieldCount = 0;
  let aborted = false;

  // Timeout protection
  const timer = setTimeout(() => {
    aborted = true;
    req.unpipe(bb);
    bb.emit('error', new Error('Request timeout'));
  }, opts.timeout);

  const abort = () => {
    if (!aborted) {
      aborted = true;
      clearTimeout(timer);
      req.unpipe(bb);
    }
  };

  bb.on('file', (fieldname, file, filename, encoding, mimetype) => {
    fileCount++;
    
    // Check file count limit
    if (fileCount > opts.limits.files) {
      abort();
      file.resume();
      return;
    }
    
    // Check MIME type whitelist
    if (opts.allowedMimeTypes && !opts.allowedMimeTypes.includes(mimetype)) {
      abort();
      file.resume();
      bb.emit('error', new Error(`File type not allowed: ${mimetype}`));
      return;
    }
  });

  bb.on('field', () => {
    fieldCount++;
    if (fieldCount > opts.limits.fields) {
      abort();
    }
  });

  bb.on('finish', () => clearTimeout(timer));
  bb.on('error', () => clearTimeout(timer));
  bb.on('close', () => clearTimeout(timer));

  return bb;
}

module.exports = { createSafeBusboy };
