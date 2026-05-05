import { Router } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';
import { centralRegister, centralLogin, exchangeCode } from '../config/sso.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

async function findOrCreateProfile(centralUser) {
  const userId = centralUser.central_user_id;
  const { rows: existing } = await pool.query(
    'SELECT * FROM profiles WHERE central_user_id = $1',
    [userId]
  );
  if (existing[0]) {
    await pool.query(
      `UPDATE profiles SET username=$1, email=$2, first_name=$3, last_name=$4, updated_at=NOW()
       WHERE central_user_id=$5`,
      [centralUser.username, centralUser.email, centralUser.first_name, centralUser.last_name, userId]
    );
    return { ...existing[0], username: centralUser.username, email: centralUser.email };
  }
  const { rows } = await pool.query(
    `INSERT INTO profiles (central_user_id, username, email, first_name, last_name)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, centralUser.username, centralUser.email, centralUser.first_name || '', centralUser.last_name || '']
  );
  return rows[0];
}

function issueToken(profile) {
  return jwt.sign(
    { central_user_id: profile.central_user_id, username: profile.username },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

router.post('/register', async (req, res) => {
  try {
    const data = await centralRegister(req.body);
    const profile = await findOrCreateProfile(data);
    res.json({ token: issueToken(profile), user: profile });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const data = await centralLogin(req.body);
    const profile = await findOrCreateProfile(data);
    res.json({ token: issueToken(profile), user: profile });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/sso-callback', async (req, res) => {
  try {
    const data = await exchangeCode(req.body.code);
    const profile = await findOrCreateProfile(data);
    res.json({ token: issueToken(profile), user: profile });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/profile', authenticate, (req, res) => {
  res.json({ user: req.user });
});

router.put('/profile', authenticate, async (req, res) => {
  const { bio } = req.body;
  const { rows } = await pool.query(
    'UPDATE profiles SET bio=$1, updated_at=NOW() WHERE central_user_id=$2 RETURNING *',
    [bio || '', req.user.central_user_id]
  );
  res.json({ user: rows[0] });
});

export default router;
