import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { genId, sanitizeFilename } from '../lib/id.js';

describe('genId', () => {
  it('generates 8-char ids', () => {
    for (let i = 0; i < 100; i++) {
      assert.equal(genId().length, 8);
    }
  });

  it('uses only [A-Za-z0-9] charset', () => {
    for (let i = 0; i < 1000; i++) {
      assert.match(genId(), /^[A-Za-z0-9]{8}$/);
    }
  });

  it('is unique over 10k ids', () => {
    const seen = new Set();
    for (let i = 0; i < 10000; i++) {
      const id = genId();
      assert.ok(!seen.has(id), `duplicate id: ${id}`);
      seen.add(id);
    }
    assert.equal(seen.size, 10000);
  });
});

describe('sanitizeFilename', () => {
  it('strips path separators', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'etcpasswd');
    assert.equal(sanitizeFilename('a/b\\c'), 'abc');
  });

  it('keeps normal names intact', () => {
    assert.equal(sanitizeFilename('my app v2.apk'), 'my app v2.apk');
  });

  it('falls back to "file" for empty/garbage names', () => {
    assert.equal(sanitizeFilename(''), 'file');
    assert.equal(sanitizeFilename('...'), 'file');
  });

  it('truncates very long names', () => {
    const long = 'a'.repeat(500) + '.apk';
    assert.ok(sanitizeFilename(long).length <= 200);
  });
});
