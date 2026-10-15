import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandler, SINGLE_PART_MAX } from '../api/sign-upload.js';
import { hashPassword } from '../lib/meta.js';

// ---- fakes -----------------------------------------------------------------
function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(obj) { res.body = obj; return res; },
  };
  return res;
}

// Records every command the handler tries to presign.
function makePresigner(captured) {
  return async function fakeGetSignedUrl(_client, command, opts = {}) {
    captured.push({ command, opts });
    const key = encodeURIComponent(command.input.Key);
    const exp = opts.expiresIn ?? 0;
    return `https://r2.test/presigned?key=${key}&expires=${exp}&sig=mock`;
  };
}

const FIXED_NOW = 1_790_000_000_000;
const ENV = {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'keyid',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'filesdevxyz',
};

function buildHandlerWith(captured, envOverrides = {}) {
  Object.assign(process.env, ENV, envOverrides);
  return buildHandler({
    // Empty bucket listing keeps the storage-cap check out of the way.
    makeClient: () => ({ async send() { return { Contents: [], IsTruncated: false }; } }),
    getSignedUrl: makePresigner(captured),
    now: () => FIXED_NOW,
  });
}

const validBody = () => ({
  filename: 'My App v2.apk',
  contentType: 'application/vnd.android.package-archive',
  size: 50 * 1024 * 1024,
});

beforeEach(() => {
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'MAX_FILE_SIZE']) {
    delete process.env[k];
  }
});

describe('sign-upload', () => {
  it('signs a PUT url for a valid request', async () => {
    const captured = [];
    const handler = buildHandlerWith(captured);
    const res = makeRes();
    await handler({ method: 'POST', body: validBody() }, res);

    assert.equal(res.statusCode, 200);
    assert.match(res.body.id, /^[A-Za-z0-9]{8}$/);
    assert.equal(res.body.key, `${res.body.id}/My App v2.apk`);
    assert.equal(res.body.downloadUrl, `/f/${res.body.id}`);
    assert.ok(res.body.uploadUrl.includes('sig=mock'));
    assert.ok(res.body.uploadUrl.includes(`key=${encodeURIComponent(res.body.key)}`));

    const { command, opts } = captured[0];
    assert.equal(command.input.Bucket, 'filesdevxyz');
    assert.equal(command.input.Key, res.body.key);
    assert.equal(command.input.ContentType, 'application/vnd.android.package-archive');
    assert.equal(opts.expiresIn, 900); // 15 min to complete the upload
  });

  it('does NOT bake metadata into the presigned PUT (R2 would silently drop it)', async () => {
    const captured = [];
    const handler = buildHandlerWith(captured);
    const res = makeRes();
    await handler({
      method: 'POST',
      body: { ...validBody(), password: 's3cret', expiresInHours: 24 },
    }, res);

    assert.equal(res.statusCode, 200);
    // Metadata rides along via /api/finalize after the PUT instead.
    assert.equal(captured[0].command.input.Metadata, undefined);
  });

  it('rejects missing filename', async () => {
    const handler = buildHandlerWith([]);
    const res = makeRes();
    await handler({ method: 'POST', body: { ...validBody(), filename: '' } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /filename/i);
  });

  it('rejects missing content-type', async () => {
    const handler = buildHandlerWith([]);
    const res = makeRes();
    await handler({ method: 'POST', body: { ...validBody(), contentType: '' } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /content-type/i);
  });

  it('rejects files over MAX_FILE_SIZE', async () => {
    const handler = buildHandlerWith([], { MAX_FILE_SIZE: '1000' });
    const res = makeRes();
    await handler({ method: 'POST', body: { ...validBody(), size: 1001 } }, res);
    assert.equal(res.statusCode, 413);
    assert.match(res.body.error, /too large/i);
  });

  it('defaults MAX_FILE_SIZE to 2GB', async () => {
    const handler = buildHandlerWith([]); // no MAX_FILE_SIZE in env
    // Under the cap but over the single-PUT threshold → multipart branch, not "too large"
    const res = makeRes();
    await handler({ method: 'POST', body: { ...validBody(), size: SINGLE_PART_MAX + 1 } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.useMultipart, true);
    // Over the 2GB default cap → rejected as too large
    const res2 = makeRes();
    await handler({ method: 'POST', body: { ...validBody(), size: 2 * 1024 ** 3 + 1 } }, res2);
    assert.equal(res2.statusCode, 413);
  });

  it('rejects single-PUT for files over the multipart threshold', async () => {
    assert.ok(SINGLE_PART_MAX === 1024 ** 3, 'threshold must be 1GB');
    const handler = buildHandlerWith([]);
    const res = makeRes();
    await handler({ method: 'POST', body: { ...validBody(), size: SINGLE_PART_MAX + 1 } }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /multipart/i);
    assert.equal(res.body.useMultipart, true);
  });

  it('rejects non-POST methods', async () => {
    const handler = buildHandlerWith([]);
    const res = makeRes();
    await handler({ method: 'GET', body: {} }, res);
    assert.equal(res.statusCode, 405);
  });

  it('returns 500 when R2 config is missing', async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    const handler = buildHandler({
      makeClient: () => ({ async send() { return { Contents: [], IsTruncated: false }; } }),
      getSignedUrl: makePresigner([]),
      now: () => FIXED_NOW,
    });
    const res = makeRes();
    await handler({ method: 'POST', body: validBody() }, res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /not configured/i);
  });
});
