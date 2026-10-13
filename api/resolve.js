import { ListObjectsV2Command, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import { makeS3Client, requireConfig } from '../lib/r2.js';
import { verifyPassword, isExpired } from '../lib/meta.js';

export const DOWNLOAD_URL_TTL_SECONDS = 3600; // download link valid for 1 hour
const ID_RE = /^[A-Za-z0-9]{8}$/;

export function buildResolveHandler(deps = {}) {
  const {
    makeClient = makeS3Client,
    getSignedUrl = awsGetSignedUrl,
    now = Date.now,
  } = deps;

  return async function handler(req, res) {
    try {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'method not allowed' });
      }
      const cfg = requireConfig(process.env);

      const id = (req.query && req.query.id) || '';
      if (!ID_RE.test(id)) {
        return res.status(400).json({ error: 'invalid file id' });
      }

      const client = makeClient(process.env);
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: `${id}/`, MaxKeys: 1 })
      );
      const key = listed.Contents && listed.Contents[0] && listed.Contents[0].Key;
      if (!key) {
        return res.status(404).json({ error: 'file not found' });
      }

      let head;
      try {
        head = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
      } catch (e) {
        if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
          return res.status(404).json({ error: 'file not found' });
        }
        throw e;
      }

      const meta = head.Metadata || {};
      if (isExpired(meta['x-amz-meta-exp'], now())) {
        return res.status(410).json({ error: 'this link has expired' });
      }

      const storedPw = meta['x-amz-meta-pw'] || null;
      const passwordProtected = !!storedPw;
      if (storedPw) {
        const provided = req.query.password;
        if (provided == null || provided === '') {
          return res.status(403).json({ error: 'password required', passwordProtected: true });
        }
        if (!verifyPassword(provided, storedPw)) {
          return res.status(403).json({ error: 'wrong password', passwordProtected: true });
        }
      }

      const filename = meta['x-amz-meta-name']
        ? decodeURIComponent(meta['x-amz-meta-name'])
        : key.slice(key.indexOf('/') + 1);

      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
        }),
        { expiresIn: DOWNLOAD_URL_TTL_SECONDS }
      );

      return res.status(200).json({
        url,
        filename,
        size: head.ContentLength ?? null,
        expiresAt: meta['x-amz-meta-exp'] || null,
        passwordProtected,
      });
    } catch (e) {
      if (e.message && e.message.startsWith('R2 not configured')) {
        return res.status(500).json({ error: e.message });
      }
      console.error('[resolve]', e);
      return res.status(500).json({ error: 'failed to resolve file' });
    }
  };
}

export default buildResolveHandler();
