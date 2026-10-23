import { Router } from 'express';
import pool, { toId } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { wrap } from '../middleware/wrap.js';
import { nameError, textError } from '../services/circles.js';

const router = Router();

const VALID_KINDS = ['have', 'need'];
const VALID_CATEGORIES = ['item', 'time', 'space', 'skill', 'service', 'event', 'other'];

// tags is a TEXT[] column; anything but a list of strings makes Postgres reject the query.
const validTags = (tags) => tags == null || (Array.isArray(tags) && tags.every((t) => typeof t === 'string' && !t.includes('\0')));

// The text fields beyond the title: Postgres rejects a NUL character in any of them.
const textFieldError = ({ description, availability }) =>
  textError(description, 'Description') || textError(availability, 'Availability');

router.use(authenticate);

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
  let where = 'l.circle_id = $1 AND l.active';
  if (kind && VALID_KINDS.includes(kind)) {
    params.push(kind);
    where += ` AND l.kind = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT l.*, p.username, p.first_name, p.last_name
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
  await pool.query('DELETE FROM listings WHERE id = $1', [id]);
  res.json({ ok: true });
}));

router.get('/mine', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*, c.name AS circle_name
     FROM listings l
     JOIN circles c ON c.id = l.circle_id
     WHERE l.central_user_id = $1
     ORDER BY l.created_at DESC`,
    [req.user.central_user_id]
  );
  res.json({ listings: rows });
}));

export default router;
