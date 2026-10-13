import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  isExpired,
  expiryFromHours,
  validateUpload,
} from '../lib/meta.js';

describe('password hashing', () => {
  it('hashes deterministically to 64 hex chars', () => {
    const h1 = hashPassword('s3cret!');
    const h2 = hashPassword('s3cret!');
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });

  it('different passwords give different hashes', () => {
    assert.notEqual(hashPassword('a'), hashPassword('b'));
  });
});

describe('verifyPassword', () => {
  const stored = hashPassword('correct-horse');

  it('accepts the correct password', () => {
    assert.equal(verifyPassword('correct-horse', stored), true);
  });

  it('rejects a wrong password', () => {
    assert.equal(verifyPassword('wrong-horse', stored), false);
  });

  it('rejects when no password hash is stored but one is given (unprotected file)', () => {
    assert.equal(verifyPassword('anything', null), true);
    assert.equal(verifyPassword('anything', undefined), true);
    assert.equal(verifyPassword('anything', ''), true);
  });

  it('rejects empty provided password against a stored hash', () => {
    assert.equal(verifyPassword('', stored), false);
    assert.equal(verifyPassword(null, stored), false);
  });

  it('is case sensitive', () => {
    assert.equal(verifyPassword('Correct-Horse', stored), false);
  });
});

describe('isExpired', () => {
  const now = 1_790_000_000_000;

  it('returns true for past timestamps', () => {
    assert.equal(isExpired(String(now - 1000), now), true);
  });

  it('returns false for future timestamps', () => {
    assert.equal(isExpired(String(now + 3600_000), now), false);
  });

  it('returns false when no expiry is set', () => {
    assert.equal(isExpired(null, now), false);
    assert.equal(isExpired(undefined, now), false);
    assert.equal(isExpired('', now), false);
  });

  it('treats unparseable values as not expired (fail open on corrupt meta)', () => {
    assert.equal(isExpired('not-a-number', now), false);
  });

  it('expires exactly at the boundary (<= now)', () => {
    assert.equal(isExpired(String(now), now), true);
  });
});

describe('expiryFromHours', () => {
  it('converts hours to epoch-ms string', () => {
    const now = 1_000_000;
    assert.equal(expiryFromHours(24, now), String(now + 24 * 3600_000));
  });

  it('returns null for no/zero/invalid expiry', () => {
    assert.equal(expiryFromHours(0, 1), null);
    assert.equal(expiryFromHours(null, 1), null);
    assert.equal(expiryFromHours(-5, 1), null);
  });
});

describe('validateUpload', () => {
  const ok = { filename: 'app.apk', contentType: 'application/vnd.android.package-archive', size: 1024 };
  const maxSize = 2 * 1024 ** 3;

  it('accepts a valid request', () => {
    assert.equal(validateUpload(ok, maxSize), null);
  });

  it('rejects missing filename', () => {
    assert.equal(validateUpload({ ...ok, filename: '' }, maxSize), 'filename is required');
    assert.equal(validateUpload({ ...ok, filename: null }, maxSize), 'filename is required');
  });

  it('rejects missing content-type', () => {
    assert.equal(validateUpload({ ...ok, contentType: '' }, maxSize), 'content-type is required');
  });

  it('rejects non-positive size', () => {
    assert.equal(validateUpload({ ...ok, size: 0 }, maxSize), 'size must be a positive number');
    assert.equal(validateUpload({ ...ok, size: -5 }, maxSize), 'size must be a positive number');
    assert.equal(validateUpload({ ...ok, size: 'big' }, maxSize), 'size must be a positive number');
  });

  it('rejects files over the cap', () => {
    assert.equal(
      validateUpload({ ...ok, size: maxSize + 1 }, maxSize),
      `file too large (max ${maxSize} bytes)`
    );
  });

  it('accepts a file exactly at the cap', () => {
    assert.equal(validateUpload({ ...ok, size: maxSize }, maxSize), null);
  });
});
