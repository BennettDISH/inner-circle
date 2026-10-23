// GET /health, for Railway's deploy healthcheck: the process is up and serving, and one
// SELECT 1 comes back within TIMEOUT_MS. Nothing else is read, so it stays cheap however often it
// is asked. 200 { status: 'ok', db: 'ok' } or 503 { status: 'unavailable', db: 'not answering' }
// when the database errors or keeps silent. The database's own error text is never sent.

import pool from '../config/db.js';

export const TIMEOUT_MS = 3000;

export function healthHandler({ query = (sql) => pool.query(sql), timeoutMs = TIMEOUT_MS } = {}) {
  return async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    let timer;
    const asked = Promise.resolve().then(() => query('SELECT 1'));
    asked.catch(() => {}); // a late failure after the timeout must not become an unhandled rejection
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); });
    try {
      await Promise.race([asked, late]);
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable', db: 'not answering' });
    } finally {
      clearTimeout(timer);
    }
  };
}
