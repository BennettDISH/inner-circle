import { Router } from 'express';
import pool, { toId } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { wrap } from '../middleware/wrap.js';
import { createLimiter } from '../middleware/rateLimit.js';
import { insertCircle, nameError, textError } from '../services/circles.js';

const router = Router();

// Join codes are 6 base-36 characters, so guessing has to be slow: after 10 wrong codes in 15
// minutes from one address, or from one account, joining answers 429 until the window ends.
// Right codes aren't counted.
const JOIN_MAX_WRONG = 10;
const wrongJoins = createLimiter({ max: JOIN_MAX_WRONG, windowMs: 15 * 60 * 1000 });

router.use(authenticate);

router.get('/', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, cm.role,
       (SELECT COUNT(*)::int FROM circle_members WHERE circle_id = c.id) AS member_count,
       (SELECT COUNT(*)::int FROM listings WHERE circle_id = c.id AND active) AS listing_count
     FROM circles c
     JOIN circle_members cm ON cm.circle_id = c.id
     WHERE cm.central_user_id = $1
     ORDER BY c.created_at DESC`,
    [req.user.central_user_id]
  );
  res.json({ circles: rows });
}));

router.post('/', wrap(async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const invalid = nameError(name, 'Name') || textError(description, 'Description');
  if (invalid) return res.status(400).json({ error: invalid });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const circle = await insertCircle(client, {
      name,
      description: description || '',
      createdBy: req.user.central_user_id,
    });
    await client.query(
      `INSERT INTO circle_members (circle_id, central_user_id, role)
       VALUES ($1, $2, 'admin')`,
      [circle.id, req.user.central_user_id]
    );
    await client.query('COMMIT');
    res.json({ circle });
  } catch (err) {
    // Whatever failed is the server's problem, not the caller's: the error handler logs it and
    // answers 500 without Postgres's wording.
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

router.post('/join', wrap(async (req, res) => {
  const { join_code } = req.body;
  const keys = [`ip:${req.ip}`, `user:${req.user.central_user_id}`];
  if (keys.some((k) => wrongJoins.blocked(k))) {
    return res.status(429).json({ error: 'Too many wrong codes. Wait 15 minutes and try again.' });
  }
  const { rows: circles } = await pool.query(
    'SELECT * FROM circles WHERE join_code = $1',
    [String(join_code ?? '').toUpperCase()]
  );
  if (!circles[0]) {
    keys.forEach((k) => wrongJoins.hit(k));
    return res.status(404).json({ error: 'Circle not found' });
  }

  await pool.query(
    `INSERT INTO circle_members (circle_id, central_user_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [circles[0].id, req.user.central_user_id]
  );
  res.json({ circle: circles[0] });
}));

router.get('/:id', wrap(async (req, res) => {
  const circleId = toId(req.params.id);
  if (circleId === null) return res.status(400).json({ error: 'Invalid circle id' });
  const { rows: members } = await pool.query(
    `SELECT cm.*, p.username, p.first_name, p.last_name
     FROM circle_members cm
     JOIN profiles p ON p.central_user_id = cm.central_user_id
     WHERE cm.circle_id = $1`,
    [circleId]
  );
  const isMember = members.some(m => m.central_user_id === req.user.central_user_id);
  if (!isMember) return res.status(403).json({ error: 'Not a member' });

  const { rows: circles } = await pool.query('SELECT * FROM circles WHERE id = $1', [circleId]);
  res.json({ circle: circles[0], members });
}));

router.delete('/:id/leave', wrap(async (req, res) => {
  const circleId = toId(req.params.id);
  if (circleId === null) return res.status(400).json({ error: 'Invalid circle id' });
  await pool.query(
    'DELETE FROM circle_members WHERE circle_id = $1 AND central_user_id = $2',
    [circleId, req.user.central_user_id]
  );
  res.json({ ok: true });
}));

export default router;
