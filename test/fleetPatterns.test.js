// The shared hardening: "Switch account" (?prompt=login), a time limit on every R2 call, a photo
// stream that is let go of when the browser walks away, and a request log with nothing secret in it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let app;
before(async () => { app = await startApp({ fakeR2: true }); });
after(async () => { await app?.stop(); });

// A real WebP header is enough for the app's check by magic bytes.
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(32)]);

async function listingWithPhoto() {
  const owner = await app.user();
  const circle = (await owner.as('POST', '/api/circles', { name: 'Family', description: 'x' })).body.circle;
  const listing = (await owner.as('POST', '/api/listings', {
    circle_id: circle.id, kind: 'have', category: 'item', title: 'Cordless drill', description: 'With bits', tags: [],
  })).body.listing;
  const photo = await owner.photo(listing.id, WEBP);
  assert.equal(photo.status, 201, JSON.stringify(photo.body));
  return { owner, listing, photoId: photo.body.photo.id };
}

describe('Switch account', () => {
  it('?prompt=login is passed on to Waypoint, and nothing else is', async () => {
    const raw = await fetch(`${app.base}/api/auth/sso/login?state=abc&prompt=login`, { redirect: 'manual' });
    assert.equal(raw.status, 302);
    const to = new URL(raw.headers.get('location'));
    assert.equal(to.searchParams.get('prompt'), 'login');
    assert.equal(to.searchParams.get('state'), 'abc');
    for (const other of ['&prompt=none', '&prompt=consent', '']) {
      const res = await fetch(`${app.base}/api/auth/sso/login?state=abc${other}`, { redirect: 'manual' });
      assert.equal(new URL(res.headers.get('location')).searchParams.get('prompt'), null, other || '(no prompt)');
    }
  });
});

describe('R2 calls have a time limit', () => {
  it('a photo upload, read and delete all reach the bucket with an abort signal', async () => {
    const { owner, listing, photoId } = await listingWithPhoto();
    assert.equal((await owner.getPhoto(listing.id, photoId)).status, 200);
    assert.equal((await owner.as('DELETE', `/api/listings/${listing.id}/photos/${photoId}`)).status, 200);
    const calls = app.r2.calls();
    for (const command of ['PutObjectCommand', 'GetObjectCommand', 'DeleteObjectCommand']) {
      assert.ok(calls.some((c) => c.command === command), `${command} was made`);
    }
    assert.ok(calls.every((c) => c.timeLimited), JSON.stringify(calls.filter((c) => !c.timeLimited)));
  });
});

describe('a photo the browser stops reading', () => {
  it('lets go of the bucket\'s stream when the browser walks away', async () => {
    const { owner, listing, photoId } = await listingWithPhoto();
    app.r2.flag('SLOW_GET');
    try {
      const controller = new AbortController();
      const res = await fetch(`${app.base}/api/listings/${listing.id}/photos/${photoId}`, {
        headers: { Authorization: `Bearer ${owner.token}`, 'X-Forwarded-For': owner.address },
        signal: controller.signal,
      });
      assert.equal(res.status, 200);
      const reader = res.body.getReader();
      await reader.read(); // the first bytes arrive; the rest never does
      assert.ok(!app.r2.has('STREAM_CLOSED'), 'still open while the browser waits');
      controller.abort();
      await reader.read().catch(() => {});
      for (let i = 0; i < 100 && !app.r2.has('STREAM_CLOSED'); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(app.r2.has('STREAM_CLOSED'), 'the stream from the bucket was destroyed');
    } finally {
      app.r2.flag('SLOW_GET', false);
    }
  });
});

describe('the request log', () => {
  it('has an id, method, path and status, never a query string; the healthcheck is not logged', async () => {
    const res = await fetch(`${app.base}/api/auth/sso/login?state=secret-state-123&prompt=login`, {
      redirect: 'manual',
      headers: { 'X-Request-Id': 'trace-me-0051' },
    });
    assert.equal(res.headers.get('x-request-id'), 'trace-me-0051');
    await app.request('GET', '/health');
    await app.request('GET', '/api/circles'); // 401: no token
    await new Promise((r) => setTimeout(r, 100));
    const log = app.log();
    assert.match(log, /trace-me-0051 GET \/api\/auth\/sso\/login 302 \d+ms/);
    assert.match(log, /GET \/api\/circles 401 \d+ms/);
    assert.doesNotMatch(log, /secret-state-123|state=|prompt=/);
    assert.doesNotMatch(log, /GET \/health /);
  });
});
