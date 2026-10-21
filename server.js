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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Trust the proxy (Railway) so req.protocol reflects the original https scheme when
// building the SSO redirect_uri.
app.set('trust proxy', true);

app.use(helmet({ contentSecurityPolicy: false }));
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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
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
