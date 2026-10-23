// Listing photos on R2: what an upload may be, how much one account may add in a day, the
// object keys, and letting go of objects that no listing points at any more.
import crypto from 'node:crypto';
import { r2Enabled, deleteImage } from '../config/r2.js';

/** One upload, after the page has shrunk it (WebP, longest side 2048 px, usually well under 1 MB). */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const MAX_PHOTOS_PER_LISTING = 4;
export const PHOTOS_OFF = 'Photos are not set up yet';

/** What the bytes are, by their magic numbers, never by what the client says. Only the
 *  formats a browser draws from a canvas: no GIF, and never SVG (it can carry script). */
export function sniffImage(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { ext: 'webp', type: 'image/webp' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', type: 'image/png' };
  }
  return null;
}

/** An amount per key (an account) for a fixed window: `room(key)` is what is left, `add(key, n)`
 *  spends n (a negative n gives it back), `resetIn(key)` is the seconds to the window's end.
 *  In memory: a deploy starts every window over. */
export function budgetPer(windowMs, max) {
  const spent = new Map(); // key -> { used, until }
  const live = (key, now) => {
    const h = spent.get(key);
    return h && h.until > now ? h : null;
  };
  return {
    max,
    room(key) { return max - (live(key, Date.now())?.used ?? 0); },
    add(key, n) {
      const now = Date.now();
      const h = live(key, now) ?? { used: 0, until: now + windowMs };
      h.used = Math.max(0, h.used + n);
      spent.set(key, h);
      if (spent.size > 10000) for (const [k, v] of spent) if (v.until <= now) spent.delete(k);
    },
    resetIn(key) {
      const h = live(key, Date.now());
      return h ? Math.ceil((h.until - Date.now()) / 1000) : 0;
    },
  };
}

/** What one account may add in a day: 50 MB, about a hundred photos at the usual size. */
const DAY_MS = 24 * 60 * 60 * 1000;
export const MB = 1024 * 1024;
export let photoBudget = budgetPer(DAY_MS, 50 * MB);
/** The suite's seam: a budget of this many bytes, fresh. */
export function photoBudgetForTests(bytes) {
  if (process.env.NODE_ENV !== 'test') throw new Error('photoBudgetForTests is for the test suite');
  photoBudget = budgetPer(DAY_MS, bytes);
}

/** Photos live under their circle, so a circle's objects can be told from any other's. */
export const newPhotoKey = (circleId, ext) =>
  `circles/${circleId}/${crypto.randomBytes(12).toString('hex')}.${ext}`;

/** Objects no listing points at leave the bucket. Best effort: a failure is logged and the
 *  request that let go of them has already succeeded. */
export async function releasePhotos(keys) {
  if (!r2Enabled) return;
  for (const key of keys) {
    if (!key) continue;
    try {
      await deleteImage(key);
    } catch (err) {
      console.error('Photo release failed:', err.name, err.$metadata?.httpStatusCode ?? '', err.message);
    }
  }
}

/** The stored photos of a listing, asked before the listing (and with it its photo rows) is
 *  deleted. `db` is the pool or the client holding the transaction. */
export async function photoKeysOfListing(db, listingId) {
  const { rows } = await db.query('SELECT object_key FROM listing_photos WHERE listing_id = $1', [listingId]);
  return rows.map((r) => r.object_key);
}

/** The stored photos of every listing in these circles, asked before the circles go. */
export async function photoKeysOfCircles(db, circleIds) {
  const { rows } = await db.query(
    `SELECT ph.object_key FROM listing_photos ph JOIN listings l ON l.id = ph.listing_id
     WHERE l.circle_id = ANY($1)`,
    [circleIds]
  );
  return rows.map((r) => r.object_key);
}
