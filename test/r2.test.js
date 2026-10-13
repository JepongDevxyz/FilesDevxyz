import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAccountId, requireConfig } from '../lib/r2.js';

const ACCT = 'abcdef1234567890abcdef1234567890';

describe('normalizeAccountId', () => {
  it('keeps a bare account id as-is', () => {
    assert.equal(normalizeAccountId(ACCT), ACCT);
  });

  it('extracts the id from a full S3 API endpoint URL', () => {
    assert.equal(
      normalizeAccountId(`https://${ACCT}.r2.cloudflarestorage.com`),
      ACCT
    );
  });

  it('extracts the id from a dashboard URL', () => {
    assert.equal(normalizeAccountId(`https://dash.cloudflare.com/${ACCT}/r2`), ACCT);
  });

  it('trims whitespace', () => {
    assert.equal(normalizeAccountId(`  ${ACCT}\n`), ACCT);
  });

  it('returns the input when no id pattern is found', () => {
    assert.equal(normalizeAccountId('not-an-id'), 'not-an-id');
  });
});

describe('requireConfig account id normalization', () => {
  const base = {
    R2_ACCOUNT_ID: `https://${ACCT}.r2.cloudflarestorage.com`,
    R2_ACCESS_KEY_ID: 'k',
    R2_SECRET_ACCESS_KEY: 's',
    R2_BUCKET: 'b',
  };

  it('normalizes a pasted endpoint URL to the bare account id', () => {
    assert.equal(requireConfig({ ...base }).accountId, ACCT);
  });
});
