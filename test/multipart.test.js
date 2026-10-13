import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignPartHandler, PART_SIZE } from '../api/sign-part.js';
import { buildCompleteHandler } from '../api/complete-multipart.js';
import { hashPassword } from '../lib/meta.js';

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(obj) { res.body = obj; return res; },
  };
  return res;
}

function makePresigner(captured) {
  return async function fakeGetSignedUrl(_client, command, opts = {}) {
    captured.push({ command, opts });
    const name = command.constructor.name;
    const key = encodeURIComponent(command.input.Key || '');
    return `https://r2.test/${name}?key=${key}&sig=mock`;
  };
}

const FIXED_NOW = 1_790_000_000_000;
const ENV = {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'keyid',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'filesdevxyz',
};

// Fake S3 client: createMultipart returns a fake uploadId, completeMultipart echoes back.
function makeFakeClient(captured) {
  return {
    __fake: true,
    async send(command) {
      captured.push(command);
      if (command.constructor.name === 'ListObjectsV2Command') {
        return { Contents: [], IsTruncated: false }; // empty bucket: under the storage cap
      }
      if (command.constructor.name === 'CreateMultipartUploadCommand') {
        return { UploadId: 'upload-123' };
      }
      if (command.constructor.name === 'CompleteMultipartUploadCommand') {
        return { Location: 'https://r2.test/done', Key: command.input.Key };
      }
      throw new Error('unexpected command: ' + command.constructor.name);
    },
  };
}

beforeEach(() => {
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'MAX_FILE_SIZE']) {
    delete process.env[k];
  }
  Object.assign(process.env, ENV);
});

const bigBody = (overrides = {}) => ({
  filename: 'big-movie.mkv',
  contentType: 'video/x-matroska',
  size: 250 * 1024 * 1024, // 250MB → 25 parts of 10MB
  ...overrides,
});

describe('sign-part', () => {
  it('uses 10MB parts', () => {
    assert.equal(PART_SIZE, 10 * 1024 * 1024);
  });

  it('creates a multipart upload and signs every part url', async () => {
    const captured = [];
    const clientCaptured = [];
    const handler = buildSignPartHandler({
      makeClient: () => makeFakeClient(clientCaptured),
      getSignedUrl: makePresigner(captured),
      now: () => FIXED_NOW,
    });
    const res = makeRes();
    await handler({ method: 'POST', body: bigBody() }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.uploadId, 'upload-123');
    assert.match(res.body.id, /^[A-Za-z0-9]{8}$/);
    assert.equal(res.body.partUrls.length, 25);
    assert.ok(res.body.partUrls.every((u) => u.includes('sig=mock')));
    assert.equal(res.body.downloadUrl, `/f/${res.body.id}`);

    // part numbers are 1-based and sequential
    const partNums = captured
      .filter((c) => c.command.constructor.name === 'UploadPartCommand')
      .map((c) => c.command.input.PartNumber);
    assert.deepEqual(partNums, Array.from({ length: 25 }, (_, i) => i + 1));
    // every part url targets the same key + uploadId
    assert.ok(captured.every((c) => c.command.input.Key === res.body.key));
    assert.ok(captured.every((c) => c.command.input.UploadId === 'upload-123'));
  });

  it('passes password/expiry/name metadata on create', async () => {
    const captured = [];
    const clientCaptured = [];
    const handler = buildSignPartHandler({
      makeClient: () => makeFakeClient(clientCaptured),
      getSignedUrl: makePresigner(captured),
      now: () => FIXED_NOW,
    });
    const res = makeRes();
    await handler({
      method: 'POST',
      body: bigBody({ password: 'pw9', expiresInHours: 1 }),
    }, res);
    const createCmd = clientCaptured.find((c) => c.constructor.name === 'CreateMultipartUploadCommand');
    assert.equal(createCmd.input.Metadata['x-amz-meta-pw'], hashPassword('pw9'));
    assert.equal(createCmd.input.Metadata['x-amz-meta-exp'], String(FIXED_NOW + 3600_000));
  });

  it('rejects files at/below the single-part threshold (use sign-upload instead)', async () => {
    const handler = buildSignPartHandler({
      makeClient: () => makeFakeClient([]),
      getSignedUrl: makePresigner([]),
      now: () => FIXED_NOW,
    });
    const res = makeRes();
    await handler({ method: 'POST', body: bigBody({ size: 50 * 1024 * 1024 }) }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /single/i);
  });

  it('rejects missing fields and oversize', async () => {
    const handler = buildSignPartHandler({
      makeClient: () => makeFakeClient([]),
      getSignedUrl: makePresigner([]),
      now: () => FIXED_NOW,
    });
    const r1 = makeRes();
    await handler({ method: 'POST', body: bigBody({ filename: '' }) }, r1);
    assert.equal(r1.statusCode, 400);

    process.env.MAX_FILE_SIZE = '1000';
    const r2 = makeRes();
    await handler({ method: 'POST', body: bigBody() }, r2);
    assert.equal(r2.statusCode, 413);
  });

  it('rejects non-POST', async () => {
    const handler = buildSignPartHandler({ now: () => FIXED_NOW });
    const res = makeRes();
    await handler({ method: 'GET', body: {} }, res);
    assert.equal(res.statusCode, 405);
  });
});

describe('complete-multipart', () => {
  it('completes the upload and returns the download url', async () => {
    const clientCaptured = [];
    const handler = buildCompleteHandler({
      makeClient: () => makeFakeClient(clientCaptured),
      now: () => FIXED_NOW,
    });
    const parts = [
      { ETag: '"etag1"', PartNumber: 1 },
      { ETag: '"etag2"', PartNumber: 2 },
    ];
    const res = makeRes();
    await handler({
      method: 'POST',
      body: { key: 'AbC12345/big-movie.mkv', uploadId: 'upload-123', parts },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.id, 'AbC12345');
    assert.equal(res.body.downloadUrl, '/f/AbC12345');

    const cmd = clientCaptured.find((c) => c.constructor.name === 'CompleteMultipartUploadCommand');
    assert.equal(cmd.input.UploadId, 'upload-123');
    assert.equal(cmd.input.Key, 'AbC12345/big-movie.mkv');
    assert.deepEqual(cmd.input.MultipartUpload.Parts, parts);
  });

  it('rejects missing uploadId/parts/key', async () => {
    const handler = buildCompleteHandler({ makeClient: () => makeFakeClient([]) });
    for (const body of [
      { key: 'a/b', parts: [] },
      { uploadId: 'u', parts: [] },
      { key: 'a/b', uploadId: 'u' },
      { key: 'a/b', uploadId: 'u', parts: [] },
    ]) {
      const res = makeRes();
      await handler({ method: 'POST', body }, res);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
    }
  });

  it('rejects non-POST', async () => {
    const handler = buildCompleteHandler({});
    const res = makeRes();
    await handler({ method: 'GET', body: {} }, res);
    assert.equal(res.statusCode, 405);
  });
});
