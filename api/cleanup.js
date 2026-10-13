import { DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { makeS3Client, requireConfig } from '../lib/r2.js';
import { findStaleKeys } from '../lib/retention.js';

// Runs on Vercel Cron (see vercel.json). Deletes every object older than
// RETENTION_DAYS (default 7). Guarded by CRON_SECRET — Vercel sends it as
// `Authorization: Bearer <secret>` on cron requests.
export function buildCleanupHandler(deps = {}) {
  const { makeClient = makeS3Client, now = Date.now } = deps;

  return async function handler(req, res) {
    try {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'method not allowed' });
      }
      const secret = process.env.CRON_SECRET;
      if (!secret) {
        return res.status(500).json({ error: 'cleanup not configured' });
      }
      const auth = (req.headers && req.headers.authorization) || '';
      if (auth !== `Bearer ${secret}`) {
        return res.status(401).json({ error: 'unauthorized' });
      }

      const cfg = requireConfig(process.env);
      const retentionDays = Number(process.env.RETENTION_DAYS) || 7;
      const client = makeClient(process.env);
      const keys = await findStaleKeys(client, cfg.bucket, retentionDays * 86_400_000, now());

      // DeleteObjects takes at most 1000 keys per call.
      let deleted = 0;
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        await client.send(
          new DeleteObjectsCommand({
            Bucket: cfg.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })) },
          })
        );
        deleted += batch.length;
      }

      return res.status(200).json({ deleted, retentionDays });
    } catch (e) {
      if (e.message && e.message.startsWith('R2 not configured')) {
        return res.status(500).json({ error: e.message });
      }
      console.error('[cleanup]', e);
      return res.status(500).json({ error: 'cleanup failed' });
    }
  };
}

export default buildCleanupHandler();
