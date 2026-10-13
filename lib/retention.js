import { ListObjectsV2Command } from '@aws-sdk/client-s3';

// Keys of every object whose LastModified is older than maxAgeMs.
// Objects exactly at the cutoff count as fresh; only strictly older ones go.
export async function findStaleKeys(client, bucket, maxAgeMs, now = Date.now()) {
  const cutoff = now - maxAgeMs;
  const stale = [];
  let token;
  do {
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token })
    );
    for (const o of out.Contents || []) {
      if (!o.Key) continue;
      const lm = o.LastModified instanceof Date ? o.LastModified.getTime() : Number(o.LastModified);
      if (Number.isFinite(lm) && lm < cutoff) stale.push(o.Key);
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return stale;
}
