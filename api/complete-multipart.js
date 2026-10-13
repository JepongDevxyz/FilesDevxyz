import { CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import { makeS3Client, requireConfig } from '../lib/r2.js';

export function buildCompleteHandler(deps = {}) {
  const { makeClient = makeS3Client } = deps;

  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'method not allowed' });
      }
      const cfg = requireConfig(process.env);

      const { key, uploadId, parts } = req.body || {};
      if (!key || typeof key !== 'string') {
        return res.status(400).json({ error: 'key is required' });
      }
      if (!uploadId || typeof uploadId !== 'string') {
        return res.status(400).json({ error: 'uploadId is required' });
      }
      if (!Array.isArray(parts) || parts.length === 0) {
        return res.status(400).json({ error: 'parts array is required' });
      }
      for (const p of parts) {
        if (!p || typeof p.PartNumber !== 'number' || !p.ETag) {
          return res.status(400).json({ error: 'each part needs PartNumber and ETag' });
        }
      }

      const client = makeClient(process.env);
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: cfg.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts
              .slice()
              .sort((a, b) => a.PartNumber - b.PartNumber)
              .map((p) => ({ ETag: p.ETag, PartNumber: p.PartNumber })),
          },
        })
      );

      const id = key.split('/')[0];
      return res.status(200).json({ id, key, downloadUrl: `/f/${id}` });
    } catch (e) {
      if (e.message && e.message.startsWith('R2 not configured')) {
        return res.status(500).json({ error: e.message });
      }
      console.error('[complete-multipart]', e);
      return res.status(500).json({ error: 'failed to complete multipart upload' });
    }
  };
}

export default buildCompleteHandler();
