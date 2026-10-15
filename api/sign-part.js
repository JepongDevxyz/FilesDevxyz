import { CreateMultipartUploadCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import { makeS3Client, requireConfig } from '../lib/r2.js';
import { getBucketUsageBytes, wouldExceedCap } from '../lib/cap.js';
import { genId, sanitizeFilename } from '../lib/id.js';
import { validateUpload, buildFileMetadata } from '../lib/meta.js';
import { SINGLE_PART_MAX } from './sign-upload.js';

// 10MB per part — good balance for mobile networks.
export const PART_SIZE = 10 * 1024 * 1024;
// 1 hour per part PUT — same allowance as single uploads.
const PART_URL_TTL_SECONDS = 3600;

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

      const client = makeClient(process.env);

      // Storage cap: same guard as single uploads — never exceed STORAGE_CAP_GB.
      const usage = await getBucketUsageBytes(client, cfg.bucket);
      if (wouldExceedCap(usage, size, cfg.storageCapGb)) {
        return res.status(507).json({ error: 'storage is full — delete old files to free space' });
      }

      const id = genId();
      const name = sanitizeFilename(req.body.filename);
      const key = `${id}/${name}`;

      // Metadata on the server-side CreateMultipartUpload IS stored on the
      // final object (unlike presigned PUTs) — shared helper keeps it
      // identical to what /api/finalize applies for single uploads.
      const metadata = buildFileMetadata({
        filename: req.body.filename,
        password: req.body.password,
        expiresInHours: req.body.expiresInHours,
        now: now(),
      });

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
