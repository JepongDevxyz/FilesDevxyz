import { S3Client } from '@aws-sdk/client-s3';

// All R2 config comes from env vars only. Never hardcode credentials here.
const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

export function requireConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`R2 not configured: missing ${missing.join(', ')}`);
  }
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicBase: env.R2_PUBLIC_BASE || null,
    maxFileSize: env.MAX_FILE_SIZE ? Number(env.MAX_FILE_SIZE) : 2 * 1024 ** 3,
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
