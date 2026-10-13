import { createHash, timingSafeEqual } from 'node:crypto';

// SHA-256 hex of a password. Stored in R2 object metadata as x-amz-meta-pw.
export function hashPassword(password) {
  return createHash('sha256').update(String(password), 'utf8').digest('hex');
}

// Constant-time comparison so wrong guesses can't be timed.
// No stored hash (unprotected file) → any provided value is accepted.
export function verifyPassword(provided, storedHash) {
  if (!storedHash) return true;
  if (provided == null || provided === '') return false;
  const a = Buffer.from(hashPassword(provided), 'hex');
  const b = Buffer.from(String(storedHash), 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Expiry is stored as epoch-ms string in x-amz-meta-exp. No/invalid value → never expires.
// At the boundary (exp <= now) the file is considered expired.
export function isExpired(expMeta, now = Date.now()) {
  if (expMeta == null || expMeta === '') return false;
  const exp = Number(expMeta);
  if (!Number.isFinite(exp)) return false;
  return exp <= now;
}

// Convert an "expires in N hours" UI choice to the stored epoch-ms string.
export function expiryFromHours(hours, now = Date.now()) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  return String(now + h * 3600_000);
}

// Validate an upload request body before signing. Returns null when OK,
// otherwise a human-readable error string.
export function validateUpload(body, maxSize) {
  if (!body || typeof body !== 'object') return 'invalid request body';
  if (!body.filename || typeof body.filename !== 'string' || !body.filename.trim()) {
    return 'filename is required';
  }
  if (!body.contentType || typeof body.contentType !== 'string' || !body.contentType.trim()) {
    return 'content-type is required';
  }
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) return 'size must be a positive number';
  if (size > maxSize) return `file too large (max ${maxSize} bytes)`;
  return null;
}
