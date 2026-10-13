import { ListObjectsV2Command, CopyObjectCommand } from '@aws-sdk/client-s3';
import { makeS3Client, requireConfig } from '../lib/r2.js';
import { buildFileMetadata } from '../lib/meta.js';

// POST /api/finalize — applies password/expiry/filename metadata to an object
// AFTER the browser finished uploading it.
//
// Why this exists: presigned PUT URLs only sign the `host` header, so the
// browser cannot send x-amz-meta-* headers (R2 rejects them with 403) and any
// metadata baked into the presign command is silently dropped. The only
// reliable way is a server-side CopyObject with MetadataDirective REPLACE,
// which this endpoint does with the real R2 credentials.
// (Multipart uploads don't need this: sign-part sets metadata on the
// server-side CreateMultipartUpload call.)
const ID_RE = /^[A-Za-z0-9]{8}$/;

export function buildFinalizeHandler(deps = {}) {
  const {
    makeClient = makeS3Client,
    now = Date.now,
  } = deps;

  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'method not allowed' });
      }
      const cfg = requireConfig(process.env);

      const body = req.body || {};
      const id = String(body.id || '');
      if (!ID_RE.test(id)) {
        return res.status(400).json({ error: 'invalid file id' });
      }
      if (!body.filename || typeof body.filename !== 'string' || !body.filename.trim()) {
        return res.status(400).json({ error: 'filename is required' });
      }

      const client = makeClient(process.env);
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: `${id}/`, MaxKeys: 1 })
      );
      const key = listed.Contents && listed.Contents[0] && listed.Contents[0].Key;
      if (!key) {
        return res.status(404).json({ error: 'file not found' });
      }

      const metadata = buildFileMetadata({
        filename: body.filename,
        password: body.password,
        expiresInHours: body.expiresInHours,
        now: now(),
      });

      // Self-copy with REPLACE: the standard way to update an object's
      // metadata (and content type) in place.
      await client.send(
        new CopyObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          CopySource: encodeURI(`${cfg.bucket}/${key}`),
          MetadataDirective: 'REPLACE',
          Metadata: metadata,
          ContentType: body.contentType || 'application/octet-stream',
        })
      );

      return res.status(200).json({ ok: true, id, downloadUrl: `/f/${id}` });
    } catch (e) {
      if (e.message && e.message.startsWith('R2 not configured')) {
        return res.status(500).json({ error: e.message });
      }
      console.error('[finalize]', e);
      return res.status(500).json({ error: 'failed to finalize upload' });
    }
  };
}

export default buildFinalizeHandler();
