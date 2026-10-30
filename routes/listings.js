import express, { Router } from 'express';
import pool, { toId } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { wrap } from '../middleware/wrap.js';
import { nameError, textError, OWNER_IN_CIRCLE } from '../services/circles.js';
import { r2Enabled, putImage, getImage } from '../config/r2.js';
import {
  MAX_PHOTO_BYTES, MAX_PHOTOS_PER_LISTING, MB, PHOTOS_OFF, photoBudget, sniffImage, newPhotoKey,
  releasePhotos, photoKeysOfListing,
} from '../services/photos.js';

const router = Router();

const VALID_KINDS = ['have', 'need'];
const VALID_CATEGORIES = ['item', 'time', 'space', 'skill', 'service', 'event', 'other'];

// tags is a TEXT[] column; anything but a list of strings makes Postgres reject the query.
const validTags = (tags) => tags == null || (Array.isArray(tags) && tags.every((t) => typeof t === 'string' && !t.includes('\0')));

// The text fields beyond the title: Postgres rejects a NUL character in any of them.
const textFieldError = ({ description, availability }) =>
  textError(description, 'Description') || textError(availability, 'Availability');

router.use(authenticate);

// A listing's photos, in the order they were added: [{ id }]. The bytes come from
// GET /api/listings/:id/photos/:photoId, for circle members only.
const PHOTOS = `COALESCE((SELECT json_agg(json_build_object('id', ph.id) ORDER BY ph.position, ph.id)
                          FROM listing_photos ph WHERE ph.listing_id = l.id), '[]'::json) AS photos`;

async function memberOf(centralUserId, circleId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM circle_members WHERE circle_id = $1 AND central_user_id = $2',
    [circleId, centralUserId]
  );
  return !!rows[0];
}

router.get('/', wrap(async (req, res) => {
  const kind = req.query.kind;
  if (!req.query.circle_id) return res.status(400).json({ error: 'circle_id required' });
  const circleId = toId(req.query.circle_id);
  if (circleId === null) return res.status(400).json({ error: 'Invalid circle id' });
  if (!(await memberOf(req.user.central_user_id, circleId))) {
    return res.status(403).json({ error: 'Not a member' });
  }

  const params = [circleId];
  let where = `l.circle_id = $1 AND l.active AND ${OWNER_IN_CIRCLE}`;
  if (kind && VALID_KINDS.includes(kind)) {
    params.push(kind);
    where += ` AND l.kind = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT l.*, p.username, p.first_name, p.last_name, ${PHOTOS}
     FROM listings l
     JOIN profiles p ON p.central_user_id = l.central_user_id
     WHERE ${where}
     ORDER BY l.created_at DESC`,
    params
  );
  res.json({ listings: rows });
}));

router.post('/', wrap(async (req, res) => {
  const { circle_id, kind, category, title, description, availability, tags } = req.body;
  if (!circle_id || !title) return res.status(400).json({ error: 'circle_id and title required' });
  const circleId = toId(circle_id);
  if (circleId === null) return res.status(400).json({ error: 'Invalid circle id' });
  if (!VALID_KINDS.includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  if (category && !VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (!validTags(tags)) return res.status(400).json({ error: 'Tags must be a list of strings' });
  const invalid = nameError(title, 'Title') || textFieldError(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  if (!(await memberOf(req.user.central_user_id, circleId))) {
    return res.status(403).json({ error: 'Not a member' });
  }

  const { rows } = await pool.query(
    `INSERT INTO listings (circle_id, central_user_id, kind, category, title, description, availability, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [circleId, req.user.central_user_id, kind, category || 'item', title, description || '', availability || '', tags || []]
  );
  res.json({ listing: rows[0] });
}));

router.put('/:id', wrap(async (req, res) => {
  const id = toId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid listing id' });
  const { rows: existing } = await pool.query('SELECT * FROM listings WHERE id = $1', [id]);
  if (!existing[0]) return res.status(404).json({ error: 'Not found' });
  if (existing[0].central_user_id !== req.user.central_user_id) {
    return res.status(403).json({ error: 'Not your listing' });
  }

  const { kind, category, title, description, availability, tags, active } = req.body;
  if (kind != null && !VALID_KINDS.includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  if (category != null && !VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (!validTags(tags)) return res.status(400).json({ error: 'Tags must be a list of strings' });
  // A title is required on create, so an edit can't blank it; active is a BOOLEAN column, and
  // anything Postgres can't read as one made the update fail with a 500.
  if (title != null && (typeof title !== 'string' || !title.trim())) return res.status(400).json({ error: 'Title required' });
  if (active != null && typeof active !== 'boolean') return res.status(400).json({ error: 'active must be true or false' });
  const invalid = (title != null && nameError(title, 'Title')) || textFieldError(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  const { rows } = await pool.query(
    `UPDATE listings
     SET kind = COALESCE($1, kind),
         category = COALESCE($2, category),
         title = COALESCE($3, title),
         description = COALESCE($4, description),
         availability = COALESCE($5, availability),
         tags = COALESCE($6, tags),
         active = COALESCE($7, active),
         updated_at = NOW()
     WHERE id = $8 RETURNING *`,
    [kind, category, title, description, availability, tags, active, id]
  );
  res.json({ listing: rows[0] });
}));

router.delete('/:id', wrap(async (req, res) => {
  const id = toId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid listing id' });
  const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  if (rows[0].central_user_id !== req.user.central_user_id) {
    return res.status(403).json({ error: 'Not your listing' });
  }
  // the photo rows go with the listing (ON DELETE CASCADE); their objects are asked for first
  const keys = await photoKeysOfListing(pool, id);
  await pool.query('DELETE FROM listings WHERE id = $1', [id]);
  await releasePhotos(keys);
  res.json({ ok: true });
}));

// Photos. The page shrinks a picture first (WebP, longest side 2048 px); the body is the image
// itself, not JSON. Only the listing's owner adds or removes them.
const takePhoto = express.raw({ type: 'image/*', limit: MAX_PHOTO_BYTES });

router.post('/:id/photos', (req, res, next) => {
  if (!r2Enabled) return res.status(503).json({ error: PHOTOS_OFF });
  takePhoto(req, res, (err) => {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: `Photos can be up to ${MAX_PHOTO_BYTES / MB} MB` });
    }
    next(err);
  });
}, wrap(async (req, res) => {
  const id = toId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid listing id' });
  const { rows: existing } = await pool.query(
    `SELECT l.central_user_id, l.circle_id, (SELECT COUNT(*)::int FROM listing_photos WHERE listing_id = l.id) AS photos
     FROM listings l WHERE l.id = $1`,
    [id]
  );
  if (!existing[0]) return res.status(404).json({ error: 'Not found' });
  if (existing[0].central_user_id !== req.user.central_user_id) {
    return res.status(403).json({ error: 'Not your listing' });
  }
  const buffer = req.body;
  const kind = Buffer.isBuffer(buffer) && sniffImage(buffer);
  if (!kind) return res.status(400).json({ error: 'A photo (jpeg, png or webp) is required' });
  if (existing[0].photos >= MAX_PHOTOS_PER_LISTING) {
    return res.status(409).json({ error: `A listing can have up to ${MAX_PHOTOS_PER_LISTING} photos` });
  }

  const who = req.user.central_user_id;
  if (photoBudget.room(who) < buffer.length) {
    res.set('Retry-After', String(photoBudget.resetIn(who)));
    return res.status(429).json({ error: `Photos can add up to ${photoBudget.max / MB} MB a day for an account — that is used up; try again tomorrow` });
  }
  photoBudget.add(who, buffer.length);
  const refund = () => photoBudget.add(who, -buffer.length);

  const key = newPhotoKey(existing[0].circle_id, kind.ext);
  try {
    await putImage(key, buffer, kind.type);
  } catch (err) {
    refund(); // nothing was stored
    console.error('Photo upload failed:', err.name, err.$metadata?.httpStatusCode ?? '', err.message);
    return res.status(500).json({ error: 'Upload failed' });
  }

  // The listing row is locked while the count is read and the row added, so two uploads at once
  // cannot both take the last place (nor can a listing be deleted between).
  const client = await pool.connect();
  let outcome;
  let photoId;
  try {
    await client.query('BEGIN');
    const { rows: locked } = await client.query('SELECT id FROM listings WHERE id = $1 FOR UPDATE', [id]);
    if (!locked[0]) {
      outcome = 'gone';
    } else {
      const { rows: [{ n, next }] } = await client.query(
        'SELECT COUNT(*)::int AS n, COALESCE(MAX(position) + 1, 0)::int AS next FROM listing_photos WHERE listing_id = $1',
        [id]
      );
      if (n >= MAX_PHOTOS_PER_LISTING) {
        outcome = 'full';
      } else {
        ({ rows: [{ id: photoId }] } = await client.query(
          `INSERT INTO listing_photos (listing_id, object_key, content_type, bytes, position)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [id, key, kind.type, buffer.length, next]
        ));
        outcome = 'ok';
      }
    }
    await client.query(outcome === 'ok' ? 'COMMIT' : 'ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    refund();
    await releasePhotos([key]);
    throw err;
  } finally {
    client.release();
  }
  if (outcome !== 'ok') { // the stored object has no row: it goes again
    refund();
    await releasePhotos([key]);
    return outcome === 'gone'
      ? res.status(404).json({ error: 'Not found' })
      : res.status(409).json({ error: `A listing can have up to ${MAX_PHOTOS_PER_LISTING} photos` });
  }
  res.status(201).json({ photo: { id: photoId } });
}));

router.get('/:id/photos/:photoId', wrap(async (req, res) => {
  if (!r2Enabled) return res.status(503).json({ error: PHOTOS_OFF });
  const id = toId(req.params.id);
  const photoId = toId(req.params.photoId);
  if (id === null || photoId === null) return res.status(400).json({ error: 'Invalid id' });
  const me = req.user.central_user_id;
  // a hidden listing's photos (inactive, or its owner left the circle) are its owner's alone, as
  // the listing is
  const { rows } = await pool.query(
    `SELECT ph.object_key, l.central_user_id AS owner_id, l.circle_id
     FROM listing_photos ph JOIN listings l ON l.id = ph.listing_id
     WHERE l.id = $1 AND ph.id = $2 AND ((l.active AND ${OWNER_IN_CIRCLE}) OR l.central_user_id = $3)`,
    [id, photoId, me]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  if (rows[0].owner_id !== me && !(await memberOf(me, rows[0].circle_id))) {
    return res.status(403).json({ error: 'Not a member' });
  }
  let object;
  try {
    object = await getImage(rows[0].object_key);
  } catch (err) {
    if (err.name === 'NoSuchKey') return res.status(404).json({ error: 'Not found' });
    console.error('Photo read failed:', err.name, err.$metadata?.httpStatusCode ?? '', err.message);
    return res.status(502).json({ error: 'The photo could not be read — try again' });
  }
  const { body, contentType, length } = object;
  res.set('Content-Type', contentType);
  if (length) res.set('Content-Length', String(length));
  // random key, never overwritten: the browser may keep it for good, but nothing shared may
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  // a stream that breaks on the way (storage resetting the connection) must not leave the
  // request open: pipe stops at the source's error and ends nothing on its own
  body.on('error', (err) => {
    console.error('Photo stream failed:', err.name, err.message);
    if (res.headersSent) return res.destroy();
    res.removeHeader('Content-Length');
    res.status(502).json({ error: 'The photo could not be read — try again' });
  });
  // a browser that stops asking (a cancelled image, a closed tab) must not leave the bucket's
  // response half read: pipe never destroys its source, and that connection stays checked out
  res.on('close', () => body.destroy?.());
  body.pipe(res);
}));

router.delete('/:id/photos/:photoId', wrap(async (req, res) => {
  const id = toId(req.params.id);
  const photoId = toId(req.params.photoId);
  if (id === null || photoId === null) return res.status(400).json({ error: 'Invalid id' });
  const { rows: existing } = await pool.query('SELECT central_user_id FROM listings WHERE id = $1', [id]);
  if (!existing[0]) return res.status(404).json({ error: 'Not found' });
  if (existing[0].central_user_id !== req.user.central_user_id) {
    return res.status(403).json({ error: 'Not your listing' });
  }
  const { rows } = await pool.query(
    'DELETE FROM listing_photos WHERE id = $2 AND listing_id = $1 RETURNING object_key',
    [id, photoId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  await releasePhotos([rows[0].object_key]);
  res.json({ ok: true });
}));

router.get('/mine', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*, c.name AS circle_name, ${OWNER_IN_CIRCLE} AS owner_in_circle, ${PHOTOS}
     FROM listings l
     JOIN circles c ON c.id = l.circle_id
     WHERE l.central_user_id = $1
     ORDER BY l.created_at DESC`,
    [req.user.central_user_id]
  );
  res.json({ listings: rows });
}));

export default router;
