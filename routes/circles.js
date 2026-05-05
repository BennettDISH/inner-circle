import { Router } from 'express';
import pool from '../config/db.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

function generateJoinCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

router.use(authenticate);

router.get('/', async (req, res) => {
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
});

router.post('/', async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO circles (name, description, join_code, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description || '', generateJoinCode(), req.user.central_user_id]
    );
    await client.query(
      `INSERT INTO circle_members (circle_id, central_user_id, role)
       VALUES ($1, $2, 'admin')`,
      [rows[0].id, req.user.central_user_id]
    );
    await client.query('COMMIT');
    res.json({ circle: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.post('/join', async (req, res) => {
  const { join_code } = req.body;
  const { rows: circles } = await pool.query(
    'SELECT * FROM circles WHERE join_code = $1',
    [(join_code || '').toUpperCase()]
  );
  if (!circles[0]) return res.status(404).json({ error: 'Circle not found' });

  try {
    await pool.query(
      `INSERT INTO circle_members (circle_id, central_user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [circles[0].id, req.user.central_user_id]
    );
    res.json({ circle: circles[0] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const circleId = Number(req.params.id);
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
});

router.delete('/:id/leave', async (req, res) => {
  await pool.query(
    'DELETE FROM circle_members WHERE circle_id = $1 AND central_user_id = $2',
    [Number(req.params.id), req.user.central_user_id]
  );
  res.json({ ok: true });
});

export default router;
