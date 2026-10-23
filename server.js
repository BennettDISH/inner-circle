import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './config/db.js';
import { scheduleGuestSweep } from './services/guestSweep.js';
import authRoutes from './routes/auth.js';
import circleRoutes from './routes/circles.js';
import listingRoutes from './routes/listings.js';
import requestRoutes from './routes/requests.js';
import adminRoutes from './routes/admin.js';
import { healthHandler } from './routes/health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
// Where the built pages are. Only the tests set DIST_DIR, so they don't need a build first.
const DIST = process.env.DIST_DIR || path.join(__dirname, 'dist');

// Trust the proxy (Railway) so req.protocol reflects the original https scheme when
// building the SSO redirect_uri. Exactly one hop: Railway's edge appends the address it saw to
// X-Forwarded-For, so req.ip is that last entry. `true` would make req.ip the leftmost entry,
// which the client writes itself, and the join-code and sign-in limits key on req.ip.
app.set('trust proxy', 1);

// The session token sits in localStorage, so the page may run only its own scripts and the
// bug-tracker widget's (index.html), and talk only to itself and the widget's server. On top of
// helmet's defaults (default-src, script-src 'self', object-src 'none', script-src-attr 'none',
// frame-ancestors 'self'): the widget's script and reports, its <style> (unsafe-inline, styles
// only) and its screenshot preview (data: and blob: images), and the Google Fonts App.scss
// imports. No upgrade-insecure-requests: production is https already, and a local run is http.
const BUG_TRACKER = 'https://bug-tracker-production-4ccb.up.railway.app';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'script-src': ["'self'", BUG_TRACKER],
      'connect-src': ["'self'", BUG_TRACKER],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'blob:'],
      'upgrade-insecure-requests': null,
    },
  },
}));
app.use(cors());
app.use(morgan('tiny'));
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/circles', circleRoutes);
app.use('/api/listings', listingRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/admin', adminRoutes);

// An API path no router answers is a 404 in JSON, not the SPA's index.html (a 200 the client
// can't parse) from the fallback below.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Errors from the API (wrapped route handlers, bad JSON bodies) end up here: log them and
// answer in JSON instead of leaving the request hanging.
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('API error:', err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong' : 'Bad request' });
});

app.get('/health', healthHandler());

app.use(express.static(DIST));
app.get('*', (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    scheduleGuestSweep(); // idle guests go a minute after boot, then daily
  })
  .catch((err) => {
    console.error('Database init failed:', err);
    process.exit(1);
  });
