import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildResolveHandler, DOWNLOAD_URL_TTL_SECONDS } from '../api/resolve.js';
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

const FIXED_NOW = 1_790_000_000_000;
const ENV = {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'keyid',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'filesdevxyz',
};

// In-memory "R2": id -> { key, metadata, size }
function makeFakeClient(store, captured) {
  return {
    async send(command) {
      captured.push(command);
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix;
        const found = Object.values(store).find((o) => o.key.startsWith(prefix));
        return { Contents: found ? [{ Key: found.key }] : [] };
      }
      if (name === 'HeadObjectCommand') {
        const found = Object.values(store).find((o) => o.key === command.input.Key);
        if (!found) {
          const e = new Error('NotFound');
          e.name = 'NotFound';
          throw e;
        }
        return { Metadata: found.metadata, ContentLength: found.size, ContentType: 'application/pdf' };
      }
      throw new Error('unexpected command: ' + name);
    },
  };
}

function makePresigner(captured) {
  return async function fakeGetSignedUrl(_client, command, opts = {}) {
    captured.push({ command, opts });
    return `https://r2.test/get?key=${encodeURIComponent(command.input.Key)}&sig=mock`;
  };
}

beforeEach(() => {
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) {
    delete process.env[k];
  }
  Object.assign(process.env, ENV);
});

function handlerWith(store, extraDeps = {}) {
  const captured = [];
  const presignCaptured = [];
  const handler = buildResolveHandler({
    makeClient: () => makeFakeClient(store, captured),
    getSignedUrl: makePresigner(presignCaptured),
    now: () => FIXED_NOW,
    ...extraDeps,
  });
  return { handler, captured, presignCaptured };
}

const plainFile = () => ({
  key: 'AbC12345/report.pdf',
  size: 123456,
  metadata: { 'x-amz-meta-name': encodeURIComponent('report.pdf') },
});

describe('resolve', () => {
  it('returns a signed download url for a plain file', async () => {
    const { handler, presignCaptured } = handlerWith({ x: plainFile() });
    const res = makeRes();
    await handler({ method: 'GET', query: { id: 'AbC12345' } }, res);

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.url.includes('sig=mock'));
    assert.ok(res.body.url.includes('report.pdf'));
    assert.equal(res.body.filename, 'report.pdf');
    assert.equal(res.body.size, 123456);
    assert.equal(res.body.contentType, 'application/pdf');
    assert.equal(res.body.passwordProtected, false);
    assert.equal(presignCaptured[0].opts.expiresIn, DOWNLOAD_URL_TTL_SECONDS);

    // download should force attachment with the original filename
    const getCmd = presignCaptured[0].command;
    assert.ok(getCmd.input.ResponseContentDisposition.includes('report.pdf'));
  });

  it('returns 404 for an unknown id', async () => {
    const { handler } = handlerWith({});
    const res = makeRes();
    await handler({ method: 'GET', query: { id: 'ZZZZ9999' } }, res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /not found/i);
  });

  it('returns 400 for a malformed id', async () => {
    const { handler } = handlerWith({});
    const res = makeRes();
    await handler({ method: 'GET', query: { id: '../evil' } }, res);
    assert.equal(res.statusCode, 400);
  });

  it('returns 403 when password is missing on a protected file', async () => {
    const { handler } = handlerWith({
      x: { ...plainFile(), metadata: { ...plainFile().metadata, 'x-amz-meta-pw': hashPassword('pw') } },
    });
    const res = makeRes();
    await handler({ method: 'GET', query: { id: 'AbC12345' } }, res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /password/i);
    assert.equal(res.body.passwordProtected, true);
  });

  it('returns 403 for a wrong password', async () => {
    const { handler } = handlerWith({
      x: { ...plainFile(), metadata: { ...plainFile().metadata, 'x-amz-meta-pw': hashPassword('pw') } },
    });
    const res = makeRes();
    await handler({ method: 'GET', query: { id: 'AbC12345', password: 'nope' } }, res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /wrong password/i);
  });

  it('returns 200 with the correct password', async () => {
    const { handler } = handlerWith({
      x: { ...plainFile(), metadata: { ...plainFile().metadata, 'x-amz-meta-pw': hashPassword('pw') } },
    });
    const res = makeRes();
    await handler({ method: 'GET', query: { id: 'AbC12345', password: 'pw' } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.url.includes('sig=mock'));
  });

  it('returns 410 for an expired file', async () => {
    const { handler } = handlerWith({
      x: {
        ...plainFile(),
        metadata: { ...plainFile().metadata, 'x-amz-meta-exp': String(FIXED_NOW - 1000) },
      },
    });
    const res = makeRes();
    await handler({ method: 'GET', query: { id: 'AbC12345' } }, res);
    assert.equal(res.statusCode, 410);
    assert.match(res.body.error, /expired/i);
  });

  it('still serves a file with a future expiry', async () => {
    const { handler } = handlerWith({
      x: {
        ...plainFile(),
        metadata: { ...plainFile().metadata, 'x-amz-meta-exp': String(FIXED_NOW + 3600_000) },
      },
    });
    const res = makeRes();
    await handler({ method: 'GET', query: { id: 'AbC12345' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.expiresAt, String(FIXED_NOW + 3600_000));
  });

  it('rejects non-GET methods', async () => {
    const { handler } = handlerWith({});
    const res = makeRes();
    await handler({ method: 'POST', query: {} }, res);
    assert.equal(res.statusCode, 405);
  });
});
