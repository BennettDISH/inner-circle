// Cloudflare R2 via the S3 API, for listing photos. Configured entirely by env: R2_ACCOUNT_ID,
// R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET. With any of the four missing photos
// are off: the routes answer 503 and the pages show no photo controls, so nothing ever lands
// in Postgres either. The bucket stays private (no public URL, no custom domain): the app
// streams an object to circle members only. Keys are random and never reused, so every object
// is cached for good (immutable) — but only in the member's own browser (private).
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;

export const CACHE_CONTROL = 'private, max-age=31536000, immutable';

// `let`: the tests stand a client in (useClientForTests below), and every importer sees it
export let r2Enabled = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);

let client = r2Enabled
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    })
  : null;

export const putImage = (key, buffer, contentType) =>
  client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET, Key: key, Body: buffer, ContentType: contentType, CacheControl: CACHE_CONTROL,
  }));

export async function getImage(key) {
  const res = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
  return { body: res.Body, contentType: res.ContentType ?? 'application/octet-stream', length: res.ContentLength };
}

// deleting a key that is not there is not an error
export const deleteImage = (key) =>
  client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));

/** The suite stands a fake S3 client ({ send(command) }) in for R2, or null to take it away. */
export function useClientForTests(fake) {
  client = fake;
  r2Enabled = Boolean(fake);
}
