import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildFinalizeHandler } from '../api/finalize.js';

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(obj) { res.body = obj; return res; },
  };
  return res;
}

const ENV = {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'keyid',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'filesdevxyz',
};

beforeEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  Object.assign(process.env, ENV);
});

// Fake S3 client: replays a listing, captures the CopyObject input.
function s3Client({ contents } = {}) {
  const captured = {};
  return {
    captured,
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        return { Contents: contents };
      }
      if (name === 'CopyObjectCommand') {
        captured.copy = command.input;
        return {};
      }
      throw new Error('unexpected command: ' + name);
    },
  };
}

const req = (body) => ({ method: 'POST', body });
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('finalize', () => {
  it('rejects non-POST', async () => {
    const client = s3Client();
    const res = makeRes();
    await buildFinalizeHandler({ makeClient: () => client })({ method: 'GET', body: {} }, res);
    assert.equal(res.statusCode, 405);
  });

  it('rejects invalid ids', async () => {
    const client = s3Client();
    const res = makeRes();
    await buildFinalizeHandler({ makeClient: () => client })(req({ id: 'nope' }), res);
    assert.equal(res.statusCode, 400);
  });

  it('404s when the object is not found', async () => {
    const client = s3Client({ contents: [] });
    const res = makeRes();
    await buildFinalizeHandler({ makeClient: () => client })(
      req({ id: 'AbC12345', filename: 'a.txt', contentType: 'text/plain' }), res
    );
    assert.equal(res.statusCode, 404);
  });

  it('copies the object onto itself with REPLACE metadata (password + expiry)', async () => {
    const client = s3Client({ contents: [{ Key: 'AbC12345/a.txt' }] });
    const res = makeRes();
    const now = 1_700_000_000_000;
    await buildFinalizeHandler({ makeClient: () => client, now: () => now })(
      req({
        id: 'AbC12345',
        filename: 'my file.txt',
        contentType: 'text/plain',
        password: 'secret123',
        expiresInHours: 24,
      }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.downloadUrl, '/f/AbC12345');

    const copy = client.captured.copy;
    assert.ok(copy, 'expected a CopyObject call');
    assert.equal(copy.Bucket, 'filesdevxyz');
    assert.equal(copy.Key, 'AbC12345/a.txt');
    assert.equal(copy.MetadataDirective, 'REPLACE');
    assert.equal(copy.Metadata['x-amz-meta-pw'], sha256('secret123'));
    assert.equal(copy.Metadata['x-amz-meta-exp'], String(now + 24 * 3600_000));
    assert.equal(copy.Metadata['x-amz-meta-name'], encodeURIComponent('my file.txt'));
    assert.equal(copy.ContentType, 'text/plain');
  });

  it('omits the password hash when no password is given', async () => {
    const client = s3Client({ contents: [{ Key: 'AbC12345/a.txt' }] });
    const res = makeRes();
    await buildFinalizeHandler({ makeClient: () => client })(
      req({ id: 'AbC12345', filename: 'a.txt', contentType: 'text/plain' }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.ok(!('x-amz-meta-pw' in client.captured.copy.Metadata));
    assert.ok(!('x-amz-meta-exp' in client.captured.copy.Metadata));
  });
});
