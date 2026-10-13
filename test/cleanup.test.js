import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { findStaleKeys } from '../lib/retention.js';
import { buildCleanupHandler } from '../api/cleanup.js';

const DAY = 86_400_000;
const FIXED_NOW = 1_790_000_000_000;

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(obj) { res.body = obj; return res; },
  };
  return res;
}

// Fake S3 client: replays list pages, records delete calls.
function fakeClient(pages) {
  let i = 0;
  const deleted = [];
  return {
    deleted,
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        return pages[Math.min(i++, pages.length - 1)];
      }
      if (name === 'DeleteObjectsCommand') {
        deleted.push(...command.input.Delete.Objects.map((o) => o.Key));
        return { Deleted: command.input.Delete.Objects };
      }
      throw new Error('unexpected command: ' + name);
    },
  };
}

const ENV = {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'keyid',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'filesdevxyz',
  CRON_SECRET: 'test-secret',
};

beforeEach(() => {
  for (const k of [...Object.keys(ENV), 'RETENTION_DAYS']) delete process.env[k];
  Object.assign(process.env, ENV);
});

const obj = (key, ageMs) => ({ Key: key, Size: 10, LastModified: new Date(FIXED_NOW - ageMs) });

describe('findStaleKeys', () => {
  it('returns only objects older than the max age', async () => {
    const client = fakeClient([{
      Contents: [obj('a/old.apk', 8 * DAY), obj('b/new.apk', 6 * DAY)],
      IsTruncated: false,
    }]);
    const keys = await findStaleKeys(client, 'bkt', 7 * DAY, FIXED_NOW);
    assert.deepEqual(keys, ['a/old.apk']);
  });

  it('treats exactly-at-cutoff as fresh, just-over as stale', async () => {
    const client = fakeClient([{
      Contents: [obj('a/edge.apk', 7 * DAY), obj('b/over.apk', 7 * DAY + 1)],
      IsTruncated: false,
    }]);
    const keys = await findStaleKeys(client, 'bkt', 7 * DAY, FIXED_NOW);
    assert.deepEqual(keys, ['b/over.apk']);
  });

  it('scans all pages and returns [] for an empty bucket', async () => {
    const client = fakeClient([
      { Contents: [obj('a/old.apk', 30 * DAY)], IsTruncated: true, NextContinuationToken: 't' },
      { Contents: [], IsTruncated: false },
    ]);
    assert.deepEqual(await findStaleKeys(client, 'bkt', 7 * DAY, FIXED_NOW), ['a/old.apk']);
    const empty = fakeClient([{ IsTruncated: false }]);
    assert.deepEqual(await findStaleKeys(empty, 'bkt', 7 * DAY, FIXED_NOW), []);
  });
});

describe('cleanup handler', () => {
  const authed = { method: 'GET', headers: { authorization: 'Bearer test-secret' } };

  it('deletes stale objects and reports the count', async () => {
    const client = fakeClient([{
      Contents: [obj('a/old1.apk', 8 * DAY), obj('a/old2.apk', 10 * DAY), obj('b/new.apk', 1 * DAY)],
      IsTruncated: false,
    }]);
    const handler = buildCleanupHandler({ makeClient: () => client, now: () => FIXED_NOW });
    const res = makeRes();
    await handler(authed, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deleted, 2);
    assert.deepEqual([...client.deleted].sort(), ['a/old1.apk', 'a/old2.apk']);
  });

  it('returns deleted: 0 when nothing is stale', async () => {
    const client = fakeClient([{ Contents: [obj('b/new.apk', 1 * DAY)], IsTruncated: false }]);
    const handler = buildCleanupHandler({ makeClient: () => client, now: () => FIXED_NOW });
    const res = makeRes();
    await handler(authed, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deleted, 0);
    assert.equal(client.deleted.length, 0);
  });

  it('honors a custom RETENTION_DAYS', async () => {
    process.env.RETENTION_DAYS = '30';
    const client = fakeClient([{ Contents: [obj('a/old.apk', 8 * DAY)], IsTruncated: false }]);
    const handler = buildCleanupHandler({ makeClient: () => client, now: () => FIXED_NOW });
    const res = makeRes();
    await handler(authed, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deleted, 0); // 8 days < 30-day retention
  });

  it('rejects missing or wrong bearer token', async () => {
    const handler = buildCleanupHandler({ makeClient: () => fakeClient([]), now: () => FIXED_NOW });
    const res1 = makeRes();
    await handler({ method: 'GET', headers: {} }, res1);
    assert.equal(res1.statusCode, 401);
    const res2 = makeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res2);
    assert.equal(res2.statusCode, 401);
  });

  it('returns 500 when CRON_SECRET is not configured', async () => {
    delete process.env.CRON_SECRET;
    const handler = buildCleanupHandler({ makeClient: () => fakeClient([]), now: () => FIXED_NOW });
    const res = makeRes();
    await handler(authed, res);
    assert.equal(res.statusCode, 500);
  });

  it('rejects non-GET methods', async () => {
    const handler = buildCleanupHandler({ makeClient: () => fakeClient([]), now: () => FIXED_NOW });
    const res = makeRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer test-secret' } }, res);
    assert.equal(res.statusCode, 405);
  });
});
