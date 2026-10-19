import { Router } from 'express';
import pool, { toId } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { wrap } from '../middleware/wrap.js';

const router = Router();
const VALID_STATUSES = ['pending', 'accepted', 'declined', 'completed'];

router.use(authenticate);

router.post('/', wrap(async (req, res) => {
  const { listing_id, message } = req.body;
  const listingId = toId(listing_id);
  if (listingId === null) return res.status(400).json({ error: 'Invalid listing id' });
  const { rows: listings } = await pool.query('SELECT * FROM listings WHERE id = $1', [listingId]);
  if (!listings[0]) return res.status(404).json({ error: 'Listing not found' });
  if (listings[0].central_user_id === req.user.central_user_id) {
    return res.status(400).json({ error: 'Cannot request your own listing' });
  }
  const { rows: members } = await pool.query(
    'SELECT 1 FROM circle_members WHERE circle_id = $1 AND central_user_id = $2',
    [listings[0].circle_id, req.user.central_user_id]
  );
  if (!members[0]) return res.status(403).json({ error: 'Not a member of this circle' });

  const { rows } = await pool.query(
    `INSERT INTO requests (listing_id, from_user_id, to_user_id, message)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [listingId, req.user.central_user_id, listings[0].central_user_id, message || '']
  );
  res.json({ request: rows[0] });
}));

router.get('/', wrap(async (req, res) => {
  const direction = req.query.direction || 'incoming';
  const col = direction === 'outgoing' ? 'from_user_id' : 'to_user_id';

  const { rows } = await pool.query(
    `SELECT r.*, l.title AS listing_title, l.kind AS listing_kind,
       fp.username AS from_username, fp.first_name AS from_first_name, fp.last_name AS from_last_name,
       tp.username AS to_username, tp.first_name AS to_first_name, tp.last_name AS to_last_name
     FROM requests r
     JOIN listings l ON l.id = r.listing_id
     JOIN profiles fp ON fp.central_user_id = r.from_user_id
     JOIN profiles tp ON tp.central_user_id = r.to_user_id
     WHERE r.${col} = $1
     ORDER BY r.created_at DESC`,
    [req.user.central_user_id]
  );
  res.json({ requests: rows });
}));

router.put('/:id', wrap(async (req, res) => {
  const id = toId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Invalid request id' });
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const { rows: existing } = await pool.query('SELECT * FROM requests WHERE id = $1', [id]);
  if (!existing[0]) return res.status(404).json({ error: 'Not found' });

  const isRecipient = existing[0].to_user_id === req.user.central_user_id;
  const isSender = existing[0].from_user_id === req.user.central_user_id;
  if (!isRecipient && !isSender) return res.status(403).json({ error: 'Forbidden' });
  if ((status === 'accepted' || status === 'declined') && !isRecipient) {
    return res.status(403).json({ error: 'Only recipient can accept/decline' });
  }

  const { rows } = await pool.query(
    'UPDATE requests SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [status, id]
  );
  res.json({ request: rows[0] });
}));

export default router;
