import { ListObjectsV2Command } from '@aws-sdk/client-s3';

// Total bytes currently stored in the bucket (all objects, all pages).
export async function getBucketUsageBytes(client, bucket) {
  let bytes = 0;
  let token;
  do {
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token })
    );
    for (const o of out.Contents || []) {
      bytes += Number(o.Size) || 0;
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return bytes;
}

// True when storing `incomingBytes` on top of `usageBytes` would exceed
// the cap. capGb <= 0 or invalid disables the cap entirely.
export function wouldExceedCap(usageBytes, incomingBytes, capGb) {
  const cap = Number(capGb);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return usageBytes + incomingBytes > cap * 1024 ** 3;
}
