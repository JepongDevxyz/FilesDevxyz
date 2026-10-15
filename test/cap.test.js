import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getBucketUsageBytes, wouldExceedCap } from '../lib/cap.js';
import { buildHandler, SINGLE_PART_MAX } from '../api/sign-upload.js';
import { buildSignPartHandler } from '../api/sign-part.js';

const GB = 1024 ** 3;

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(obj) { res.body = obj; return res; },
  };
  return res;
}

// Fake S3 client whose send() replays canned ListObjectsV2 pages.
function listClient(pages) {
  let i = 0;
  return {
    async send(command) {
      if (command.constructor.name !== 'ListObjectsV2Command') {
        throw new Error('unexpected command: ' + command.constructor.name);
      }
      return pages[Math.min(i++, pages.length - 1)];
    },
  };
}

const ENV = {
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'keyid',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'filesdevxyz',
};

beforeEach(() => {
  for (const k of [...Object.keys(ENV), 'MAX_FILE_SIZE', 'STORAGE_CAP_GB']) {
    delete process.env[k];
  }
  Object.assign(process.env, ENV);
});

const smallBody = (size = 50 * 1024 * 1024) => ({
  filename: 'app.apk',
  contentType: 'application/vnd.android.package-archive',
  size,
});
const bigBody = () => ({
  filename: 'big.apk',
  contentType: 'application/vnd.android.package-archive',
  size: SINGLE_PART_MAX + 1,
});

describe('getBucketUsageBytes', () => {
  it('sums sizes across paginated listings', async () => {
    const client = listClient([
      { Contents: [{ Size: 100 }, { Size: 200 }], IsTruncated: true, NextContinuationToken: 't1' },
      { Contents: [{ Size: 300 }], IsTruncated: false },
    ]);
    assert.equal(await getBucketUsageBytes(client, 'b'), 600);
  });

  it('returns 0 for an empty bucket or missing Contents', async () => {
    assert.equal(await getBucketUsageBytes(listClient([{ IsTruncated: false }]), 'b'), 0);
    assert.equal(await getBucketUsageBytes(listClient([{ Contents: [], IsTruncated: false }]), 'b'), 0);
  });
});

describe('wouldExceedCap', () => {
  it('returns false when the file still fits', () => {
    assert.equal(wouldExceedCap(8 * GB, 0.5 * GB, 9), false);
  });

  it('returns true when the file would push usage over the cap', () => {
    assert.equal(wouldExceedCap(8 * GB, 2 * GB, 9), true);
    assert.equal(wouldExceedCap(9 * GB, 1, 9), true);
  });

  it('allows a file that fits exactly at the cap', () => {
    assert.equal(wouldExceedCap(8 * GB, 1 * GB, 9), false);
  });

  it('is disabled when the cap is 0 or invalid', () => {
    assert.equal(wouldExceedCap(999 * GB, 999 * GB, 0), false);
    assert.equal(wouldExceedCap(999 * GB, 999 * GB, 'nope'), false);
  });
});

describe('sign-upload storage cap', () => {
  const presigner = async () => 'https://r2.test/signed';

  it('rejects with 507 when the bucket is over the cap', async () => {
    const handler = buildHandler({
      makeClient: () => listClient([{ Contents: [{ Size: 8.95 * GB }], IsTruncated: false }]),
      getSignedUrl: presigner,
    });
    const res = makeRes();
    // 100MB stays on the single-PUT path; 8.95GB + 100MB > 9GB cap
    await handler({ method: 'POST', body: smallBody(100 * 1024 * 1024) }, res);
    assert.equal(res.statusCode, 507);
    assert.match(res.body.error, /storage.*full/i);
  });

  it('allows upload when under the cap (default 9GB)', async () => {
    const handler = buildHandler({
      makeClient: () => listClient([{ Contents: [{ Size: 1 * GB }], IsTruncated: false }]),
      getSignedUrl: presigner,
    });
    const res = makeRes();
    await handler({ method: 'POST', body: smallBody() }, res);
    assert.equal(res.statusCode, 200);
  });

  it('honors a custom STORAGE_CAP_GB', async () => {
    process.env.STORAGE_CAP_GB = '2';
    const handler = buildHandler({
      makeClient: () => listClient([{ Contents: [{ Size: 1.99 * GB }], IsTruncated: false }]),
      getSignedUrl: presigner,
    });
    const res = makeRes();
    // 1.99GB + 50MB > 2GB custom cap
    await handler({ method: 'POST', body: smallBody(50 * 1024 * 1024) }, res);
    assert.equal(res.statusCode, 507);
  });
});

describe('sign-part storage cap', () => {
  const presigner = async () => 'https://r2.test/part';

  it('rejects multipart start with 507 when over the cap', async () => {
    const handler = buildSignPartHandler({
      // 8.95GB + ~1GB file > 9GB cap
      makeClient: () => listClient([{ Contents: [{ Size: 8.95 * GB }], IsTruncated: false }]),
      getSignedUrl: presigner,
    });
    const res = makeRes();
    await handler({ method: 'POST', body: bigBody() }, res);
    assert.equal(res.statusCode, 507);
  });
});
