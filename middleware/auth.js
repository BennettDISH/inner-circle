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

  let decoded;
  try {
    decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Only a bad token is a 401: the page drops its stored token on a 401, so a database that
  // doesn't answer must be a 500 instead of signing everyone out.
  try {
    const { rows } = await pool.query(
      'SELECT * FROM profiles WHERE central_user_id = $1',
      [decoded.central_user_id]
    );
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });
    req.user = { ...rows[0], is_admin: isAdmin(rows[0].central_user_id) };
  } catch (err) {
    return next(err);
  }
  next();
}
