import { Router } from 'express';
import pool, { toId } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { wrap } from '../middleware/wrap.js';
import { textError } from '../services/circles.js';

const router = Router();

// Who may set what. The listing's owner (the recipient) answers a request: accept, decline,
// and complete once it's done. The person who asked can only take it back ("cancelled"), and
// only while it's still open. Nobody sets a request back to "pending".
const OWNER_STATUSES = ['accepted', 'declined', 'completed'];
const SENDER_STATUSES = ['cancelled'];

router.use(authenticate);

// The listing row stays locked until the transaction ends, so two requests from the same person
// arriving together can't both see "no pending request yet". Answers { request } or { status, error }.
async function createRequest(client, listingId, userId, message) {
  const { rows: listings } = await client.query('SELECT * FROM listings WHERE id = $1 FOR UPDATE', [listingId]);
  const listing = listings[0];
  if (!listing) return { status: 404, error: 'Listing not found' };
  if (listing.central_user_id === userId) return { status: 400, error: 'Cannot request your own listing' };
  const { rows: members } = await client.query(
    'SELECT 1 FROM circle_members WHERE circle_id = $1 AND central_user_id = $2',
    [listing.circle_id, userId]
  );
  if (!members[0]) return { status: 403, error: 'Not a member of this circle' };
  // An inactive listing is hidden from its circle, so nobody should be asking for it.
  if (!listing.active) return { status: 409, error: 'This listing is no longer active' };
  const { rows: pending } = await client.query(
    `SELECT 1 FROM requests WHERE listing_id = $1 AND from_user_id = $2 AND status = 'pending'`,
    [listingId, userId]
  );
  if (pending[0]) return { status: 409, error: 'You already have a pending request for this listing' };

  const { rows } = await client.query(
    `INSERT INTO requests (listing_id, from_user_id, to_user_id, message)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [listingId, userId, listing.central_user_id, message || '']
  );
  return { request: rows[0] };
}

router.post('/', wrap(async (req, res) => {
  const { listing_id, message } = req.body;
  const listingId = toId(listing_id);
  if (listingId === null) return res.status(400).json({ error: 'Invalid listing id' });
  // Postgres cannot store a NUL character; the other text fields are checked the same way.
  const invalid = textError(message, 'Message');
  if (invalid) return res.status(400).json({ error: invalid });

  const client = await pool.connect();
  let outcome;
  try {
    await client.query('BEGIN');
    outcome = await createRequest(client, listingId, req.user.central_user_id, message);
    await client.query(outcome.request ? 'COMMIT' : 'ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (!outcome.request) return res.status(outcome.status).json({ error: outcome.error });
  res.json({ request: outcome.request });
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
  if (![...OWNER_STATUSES, ...SENDER_STATUSES].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const { rows: existing } = await pool.query('SELECT * FROM requests WHERE id = $1', [id]);
  if (!existing[0]) return res.status(404).json({ error: 'Not found' });

  const isRecipient = existing[0].to_user_id === req.user.central_user_id;
  const isSender = existing[0].from_user_id === req.user.central_user_id;
  if (!isRecipient && !isSender) return res.status(403).json({ error: 'Forbidden' });
  if (isRecipient && !OWNER_STATUSES.includes(status)) {
    return res.status(403).json({ error: 'Only the person who asked can cancel a request' });
  }
  if (isSender && !SENDER_STATUSES.includes(status)) {
    return res.status(403).json({ error: 'Only the listing owner can accept, decline or complete a request' });
  }

  // The status test is part of the UPDATE, so a request closed a moment ago stays closed. A
  // cancelled request is final for the owner; a declined, completed or cancelled one can't be
  // cancelled by the person who asked.
  const stillAllowed = isSender ? "status IN ('pending', 'accepted')" : "status <> 'cancelled'";
  const { rows } = await pool.query(
    `UPDATE requests SET status = $1, updated_at = NOW() WHERE id = $2 AND ${stillAllowed} RETURNING *`,
    [status, id]
  );
  if (!rows[0]) {
    return res.status(409).json({ error: isSender ? 'This request is already closed' : 'This request was cancelled' });
  }
  res.json({ request: rows[0] });
}));

export default router;
