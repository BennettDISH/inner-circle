import { Router } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';
import { centralRegister, centralLogin, exchangeCode, AUTH_SERVICE_URL, SSO_CLIENT_ID, SSO_ENABLED } from '../config/sso.js';
import { authenticate, isAdmin } from '../middleware/auth.js';
import { createLimiter } from '../middleware/rateLimit.js';

const router = Router();

// Guests are refused: a guest who loses the browser can never sign back in to an answer or a
// circle. Waypoint's own sign-in page offers "Continue as guest" whatever an app wants, so the
// refusal is here, before any profile or token is made.
const GUEST_REFUSED = 'Guest accounts can’t be used here. Sign in with your own account.';

// Waypoint counts password logins (/api/auth/proxy/login) and code exchanges (/oauth/token) in
// one bucket, 30 per 15 minutes per calling address, and every visitor reaches it from this
// server's one address. Without a count here, one visitor could use up the whole site's
// sign-ins. So each visitor address gets 10 tries per 15 minutes, shared by the password login
// and the SSO return the way Waypoint shares its bucket. Every try counts, right or wrong: each
// one uses a Waypoint try. This is a different count from the join-code limit, so they never use
// each other up.
const WAYPOINT_TRIES = 10;
const waypointTries = createLimiter({ max: WAYPOINT_TRIES, windowMs: 15 * 60 * 1000 });
function limitWaypointTries(req, res, next) {
  if (waypointTries.blocked(req.ip)) {
    return res.status(429).json({ error: 'Too many sign-in attempts from this network. Try again in 15 minutes.' });
  }
  waypointTries.hit(req.ip);
  next();
}

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
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${base}${CALLBACK_PATH}`;
  // Encode every param: a raw state containing "&" could append its own client_id or
  // redirect_uri to the authorize URL.
  const params = new URLSearchParams({ client_id: SSO_CLIENT_ID, redirect_uri: redirectUri, state });
  res.redirect(`${AUTH_SERVICE_URL}/oauth/authorize?${params}`);
});

// Mirror the Waypoint account into profiles in one statement. A look-then-insert let two first
// sign-ins at once (two tabs, a double click) both insert, and the loser answered 400 with
// Postgres's duplicate-key message; it also answered with the names from before this sign-in.
// Every sign-in stamps updated_at, which the guest sweep reads as "last seen".
async function findOrCreateProfile(centralUser) {
  // Central accounts may have no email — store NULL, never '', so nothing can match on a
  // blank email later.
  const { rows } = await pool.query(
    `INSERT INTO profiles (central_user_id, username, email, first_name, last_name)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (central_user_id) DO UPDATE
       SET username = EXCLUDED.username, email = EXCLUDED.email, first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name, updated_at = NOW()
     RETURNING *`,
    [centralUser.central_user_id, centralUser.username, centralUser.email || null, centralUser.first_name || '', centralUser.last_name || '']
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

// What every sign-in answers: the app's token and the profile, flagged the way /profile flags it.
function signedIn(profile) {
  return { token: issueToken(profile), user: { ...profile, is_admin: isAdmin(profile.central_user_id) } };
}

// The three ways in all end here: mirror the Waypoint account and answer with the app's token, or
// answer 403 for a guest before a profile row or a token exists.
async function signIn(res, data) {
  if (data.is_guest) return res.status(403).json({ error: GUEST_REFUSED });
  const profile = await findOrCreateProfile(data);
  res.json(signedIn(profile));
}

router.post('/register', async (req, res) => {
  try {
    await signIn(res, await centralRegister(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', limitWaypointTries, async (req, res) => {
  try {
    await signIn(res, await centralLogin(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/sso-callback', limitWaypointTries, async (req, res) => {
  try {
    await signIn(res, await exchangeCode(req.body.code));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/profile', authenticate, (req, res) => {
  res.json({ user: req.user });
});

export default router;
