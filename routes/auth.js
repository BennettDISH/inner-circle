import { Router } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';
import { centralRegister, centralLogin, centralGuest, exchangeCode, AUTH_SERVICE_URL, SSO_CLIENT_ID, SSO_ENABLED } from '../config/sso.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// The SPA route that renders AuthCallback and posts the code back to /sso-callback.
const CALLBACK_PATH = '/auth/callback';

// Public config so the client can decide whether to show the SSO button without any
// build-time (VITE) vars — SSO is configured entirely server-side.
router.get('/config', (req, res) => {
  res.json({ ssoEnabled: SSO_ENABLED });
});

// Begin SSO: build the /oauth/authorize URL SERVER-side so the client_id and auth-service
// URL never depend on the browser bundle. The client passes a random state to round-trip.
router.get('/sso/login', (req, res) => {
  if (!SSO_ENABLED) return res.status(503).send('SSO is not configured');
  const state = req.query.state || '';
  const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${base}${CALLBACK_PATH}`;
  res.redirect(
    `${AUTH_SERVICE_URL}/oauth/authorize?client_id=${SSO_CLIENT_ID}&redirect_uri=${redirectUri}&state=${state}`
  );
});

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
      [centralUser.username, centralUser.email || null, centralUser.first_name, centralUser.last_name, userId]
    );
    return { ...existing[0], username: centralUser.username, email: centralUser.email || null };
  }
  // Central accounts may have no email — store NULL, never '', so nothing can match on a
  // blank email later.
  const { rows } = await pool.query(
    `INSERT INTO profiles (central_user_id, username, email, first_name, last_name)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, centralUser.username, centralUser.email || null, centralUser.first_name || '', centralUser.last_name || '']
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

// One-click guest: mint a central guest account and sign in as it — no redirect, no form.
router.post('/guest', async (req, res) => {
  if (!SSO_ENABLED) return res.status(503).json({ error: 'Guest sign-in is not available' });
  try {
    const profile = await findOrCreateProfile(await centralGuest());
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
