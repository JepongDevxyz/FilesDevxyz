import { S3Client } from '@aws-sdk/client-s3';

// All R2 config comes from env vars only. Never hardcode credentials here.
const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

// People often paste the full S3 API endpoint URL
// (https://<accountid>.r2.cloudflarestorage.com) or a dashboard URL into
// R2_ACCOUNT_ID. Normalize any of those to the bare 32-char account id so a
// paste mistake can't break the endpoint.
export function normalizeAccountId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/[0-9a-f]{32}/i);
  if (m) return m[0].toLowerCase();
  const host = s.replace(/^https?:\/\//i, '').split(/[/:?#]/)[0];
  const first = host.split('.')[0];
  return (first || s).toLowerCase();
}

export function requireConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`R2 not configured: missing ${missing.join(', ')}`);
  }
  return {
    accountId: normalizeAccountId(env.R2_ACCOUNT_ID),
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicBase: env.R2_PUBLIC_BASE || null,
    maxFileSize: env.MAX_FILE_SIZE ? Number(env.MAX_FILE_SIZE) : 2 * 1024 ** 3,
    // 9GB default: uploads stop before the bucket can exceed the R2 free tier.
    // Set to 0 to disable the cap.
    storageCapGb: env.STORAGE_CAP_GB ? Number(env.STORAGE_CAP_GB) : 9,
  };
}

export function makeS3Client(env = process.env) {
  const cfg = requireConfig(env);
  return new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: false,
  });
}
