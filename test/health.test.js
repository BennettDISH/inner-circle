// GET /health: 200 while the database answers one SELECT 1, 503 (no database text) when it
// errors or keeps silent, never cached. The handler on its own with a stand-in query, then the
// real server with its database taken away.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { healthHandler, TIMEOUT_MS } from '../routes/health.js';
import { startApp } from './helpers.js';

/** Serve the handler on a free port; returns { get, close }. */
async function serve(options) {
  const app = express().get('/health', healthHandler(options));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async get() {
      const res = await fetch(`${base}/health`);
      return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('health handler', () => {
  it('asks the database one SELECT 1 and answers 200 when it comes back', async () => {
    const asked = [];
    const s = await serve({ query: async (sql) => { asked.push(sql); return { rows: [{}] }; } });
    try {
      const res = await s.get();
      assert.equal(res.status, 200);
      assert.equal(res.cache, 'no-store');
      assert.deepEqual(res.body, { status: 'ok', db: 'ok' });
      assert.deepEqual(asked, ['SELECT 1']);
    } finally { await s.close(); }
  });

  const failures = {
    rejects: async () => { throw new Error('password authentication failed for user "secret_user"'); },
    throws: () => { throw new Error('no pool'); },
    'keeps silent': () => new Promise(() => {}),
    'answers after the timeout': () => new Promise((_, reject) => { setTimeout(() => reject(new Error('late')), 150).unref(); }),
  };
  for (const [name, query] of Object.entries(failures)) {
    it(`answers 503 and no database text when the database ${name}`, async () => {
      const s = await serve({ query, timeoutMs: 50 });
      try {
        const res = await s.get();
        assert.equal(res.status, 503);
        assert.equal(res.cache, 'no-store');
        assert.deepEqual(res.body, { status: 'unavailable', db: 'not answering' });
      } finally { await s.close(); }
    });
  }

  it('gives up after 3 seconds by default', () => {
    assert.equal(TIMEOUT_MS, 3000);
  });
});

describe('GET /health on the running server', () => {
  let app;
  after(async () => { await app?.stop(); });

  it('is ok while the database answers, and 503 once it is gone', async () => {
    app = await startApp();
    const ok = await fetch(`${app.base}/health`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await ok.json(), { status: 'ok', db: 'ok' });

    await app.db.stop();
    const down = await fetch(`${app.base}/health`);
    assert.equal(down.status, 503);
    assert.equal(down.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await down.json(), { status: 'unavailable', db: 'not answering' });
    assert.ok(app.alive(), 'the server keeps serving');
  });
});
