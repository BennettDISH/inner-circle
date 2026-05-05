import { Router } from 'express';
import pool from '../config/db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

const VALID_KINDS = ['have', 'need', 'skill'];
const VALID_CATEGORIES = ['item', 'time', 'space', 'skill', 'service', 'event', 'other'];

router.use(authenticate);

async function memberOf(centralUserId, circleId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM circle_members WHERE circle_id = $1 AND central_user_id = $2',
    [circleId, centralUserId]
  );
  return !!rows[0];
}

router.get('/', async (req, res) => {
  const circleId = Number(req.query.circle_id);
  const kind = req.query.kind;
  if (!circleId) return res.status(400).json({ error: 'circle_id required' });
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
});

router.post('/', async (req, res) => {
  const { circle_id, kind, category, title, description, availability, tags } = req.body;
  if (!circle_id || !title) return res.status(400).json({ error: 'circle_id and title required' });
  if (!VALID_KINDS.includes(kind)) return res.status(400).json({ error: 'Invalid kind' });
  if (category && !VALID_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
  if (!(await memberOf(req.user.central_user_id, circle_id))) {
    return res.status(403).json({ error: 'Not a member' });
  }

  const { rows } = await pool.query(
    `INSERT INTO listings (circle_id, central_user_id, kind, category, title, description, availability, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [circle_id, req.user.central_user_id, kind, category || 'item', title, description || '', availability || '', tags || []]
  );
  res.json({ listing: rows[0] });
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: existing } = await pool.query('SELECT * FROM listings WHERE id = $1', [id]);
  if (!existing[0]) return res.status(404).json({ error: 'Not found' });
  if (existing[0].central_user_id !== req.user.central_user_id) {
    return res.status(403).json({ error: 'Not your listing' });
  }

  const { kind, category, title, description, availability, tags, active } = req.body;
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
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query('SELECT * FROM listings WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  if (rows[0].central_user_id !== req.user.central_user_id) {
    return res.status(403).json({ error: 'Not your listing' });
  }
  await pool.query('DELETE FROM listings WHERE id = $1', [id]);
  res.json({ ok: true });
});

router.get('/mine', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*, c.name AS circle_name
     FROM listings l
     JOIN circles c ON c.id = l.circle_id
     WHERE l.central_user_id = $1
     ORDER BY l.created_at DESC`,
    [req.user.central_user_id]
  );
  res.json({ listings: rows });
});

export default router;
