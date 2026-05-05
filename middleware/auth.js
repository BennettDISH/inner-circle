import jwt from 'jsonwebtoken';
import pool from '../config/db.js';

const ADMIN_IDS = (process.env.ADMIN_CENTRAL_USER_IDS || '').split(',').map(Number).filter(Boolean);

export function isAdmin(centralUserId) {
  return ADMIN_IDS.includes(centralUserId);
}

export async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    const { rows } = await pool.query(
      'SELECT * FROM profiles WHERE central_user_id = $1',
      [decoded.central_user_id]
    );
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });
    req.user = { ...rows[0], is_admin: isAdmin(rows[0].central_user_id) };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export async function requireMember(req, res, next) {
  const circleId = Number(req.params.circleId || req.body.circle_id || req.query.circle_id);
  if (!circleId) return res.status(400).json({ error: 'circle_id required' });
  const { rows } = await pool.query(
    'SELECT * FROM circle_members WHERE circle_id = $1 AND central_user_id = $2',
    [circleId, req.user.central_user_id]
  );
  if (!rows[0]) return res.status(403).json({ error: 'Not a member of this circle' });
  req.membership = rows[0];
  next();
}
