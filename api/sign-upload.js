import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import { makeS3Client, requireConfig } from '../lib/r2.js';
import { genId, sanitizeFilename } from '../lib/id.js';
import { validateUpload, hashPassword, expiryFromHours } from '../lib/meta.js';

// Files at or under this size use a single presigned PUT. Bigger files
// must use /api/sign-part + /api/complete-multipart.
export const SINGLE_PART_MAX = 100 * 1024 * 1024;
// How long the browser has to finish the PUT.
const UPLOAD_URL_TTL_SECONDS = 900;

// Injectable deps keep this unit-testable without real R2 credentials.
// Vercel calls the default export (wired to the real AWS SDK).
export function buildHandler(deps = {}) {
  const {
    makeClient = makeS3Client,
    getSignedUrl = awsGetSignedUrl,
    now = Date.now,
  } = deps;

  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'method not allowed' });
      }
      const cfg = requireConfig(process.env);
      const err = validateUpload(req.body, cfg.maxFileSize);
      if (err) {
        return res.status(err.startsWith('file too large') ? 413 : 400).json({ error: err });
      }

      const size = Number(req.body.size);
      if (size > SINGLE_PART_MAX) {
        return res.status(400).json({
          error: 'file too large for single upload — use multipart',
          useMultipart: true,
        });
      }

      const id = genId();
      const name = sanitizeFilename(req.body.filename);
      const key = `${id}/${name}`;

      const metadata = {
        'x-amz-meta-name': encodeURIComponent(req.body.filename.trim()),
      };
      if (req.body.password) {
        metadata['x-amz-meta-pw'] = hashPassword(req.body.password);
      }
      const exp = expiryFromHours(req.body.expiresInHours, now());
      if (exp) metadata['x-amz-meta-exp'] = exp;

      const client = makeClient(process.env);
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          ContentType: req.body.contentType,
          Metadata: metadata,
        }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS }
      );

      return res.status(200).json({ id, key, uploadUrl: url, downloadUrl: `/f/${id}` });
    } catch (e) {
      if (e.message && e.message.startsWith('R2 not configured')) {
        return res.status(500).json({ error: e.message });
      }
      console.error('[sign-upload]', e);
      return res.status(500).json({ error: 'failed to sign upload' });
    }
  };
}

export default buildHandler();
