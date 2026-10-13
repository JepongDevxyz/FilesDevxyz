import { CreateMultipartUploadCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import { makeS3Client, requireConfig } from '../lib/r2.js';
import { genId, sanitizeFilename } from '../lib/id.js';
import { validateUpload, hashPassword, expiryFromHours } from '../lib/meta.js';
import { SINGLE_PART_MAX } from './sign-upload.js';

// 10MB per part — good balance for mobile networks.
export const PART_SIZE = 10 * 1024 * 1024;
const PART_URL_TTL_SECONDS = 900;

export function buildSignPartHandler(deps = {}) {
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
      if (size <= SINGLE_PART_MAX) {
        return res.status(400).json({
          error: 'file fits in a single upload — use /api/sign-upload instead',
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
      const { UploadId } = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: cfg.bucket,
          Key: key,
          ContentType: req.body.contentType,
          Metadata: metadata,
        })
      );

      const numParts = Math.ceil(size / PART_SIZE);
      const partUrls = [];
      for (let n = 1; n <= numParts; n++) {
        partUrls.push(
          await getSignedUrl(
            client,
            new UploadPartCommand({
              Bucket: cfg.bucket,
              Key: key,
              UploadId,
              PartNumber: n,
            }),
            { expiresIn: PART_URL_TTL_SECONDS }
          )
        );
      }

      return res.status(200).json({
        id,
        key,
        uploadId: UploadId,
        partUrls,
        partSize: PART_SIZE,
        downloadUrl: `/f/${id}`,
      });
    } catch (e) {
      if (e.message && e.message.startsWith('R2 not configured')) {
        return res.status(500).json({ error: e.message });
      }
      console.error('[sign-part]', e);
      return res.status(500).json({ error: 'failed to start multipart upload' });
    }
  };
}

export default buildSignPartHandler();
