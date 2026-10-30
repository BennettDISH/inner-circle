// Site admin lists (/api/admin/*): only ADMIN_CENTRAL_USER_IDS get in, everything is look-only,
// pages hold 50, search matches anywhere, and join codes never come out.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_ID = 1000; // the stand-in Waypoint's first account
const ROUTES = ['/api/admin/status', '/api/admin/users', '/api/admin/circles', '/api/admin/members', '/api/admin/listings', '/api/admin/requests'];

let app;
let admin;
let owner;
let friend;
let family;
let book;
let dist;
const joinCodes = [];

before(async () => {
  // The page comes from a throwaway dist/ holding index.html, so no build has to run first.
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-circle-dist-'));
  fs.copyFileSync(path.join(root, 'index.html'), path.join(dist, 'index.html'));
  app = await startApp({ adminIds: String(ADMIN_ID), distDir: dist });
  const res = await app.request('POST', '/api/auth/register', {
    body: { username: 'siteadmin', email: 'admin@example.com', password: 'pw', first_name: 'Site', last_name: 'Admin' },
  });
  assert.equal(res.body.user.central_user_id, ADMIN_ID);
  admin = { ...res.body, as: (method, url, body) => app.request(method, url, { token: res.body.token, body }) };

  owner = await app.user();
  friend = await app.user();
  family = (await owner.as('POST', '/api/circles', { name: 'Garden Club', description: 'Seeds and shears' })).body.circle;
  const other = (await friend.as('POST', '/api/circles', { name: 'Book Swap' })).body.circle;
  joinCodes.push(family.join_code, other.join_code);
  await friend.as('POST', '/api/circles/join', { join_code: family.join_code });

  book = (await owner.as('POST', '/api/listings', {
    circle_id: family.id, kind: 'have', title: 'Hedge trimmer', description: 'Electric', tags: ['tools', 'outdoor'],
  })).body.listing;
  const old = (await owner.as('POST', '/api/listings', { circle_id: family.id, kind: 'need', title: 'Old rake' })).body.listing;
  await owner.as('PUT', `/api/listings/${old.id}`, { active: false });
  await friend.as('POST', '/api/listings', { circle_id: other.id, kind: 'have', title: 'Paperbacks' });
  await friend.as('POST', '/api/requests', { listing_id: book.id, message: 'Can I borrow it Saturday?' });

  // Enough accounts for a second page of users, straight into the test database.
  for (let i = 1; i <= 60; i++) {
    const n = String(i).padStart(2, '0');
    await app.db.query(
      'INSERT INTO profiles (central_user_id, username, email) VALUES ($1, $2, $3)',
      [5000 + i, `bulk${n}`, `bulk${n}@example.com`]
    );
  }
});
after(async () => {
  await app?.stop();
  if (dist) fs.rmSync(dist, { recursive: true, force: true });
});

describe('admin page', () => {
  it('/admin is the app shell for anyone: it carries no account or admin data', async () => {
    // The page is the React app; who may see what is decided by /api/admin/*, below.
    for (const token of [undefined, owner.token, admin.token]) {
      const res = await app.request('GET', '/admin', { token });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      for (const text of ['siteadmin', owner.user.username, 'Garden Club', family.join_code]) {
        assert.ok(!String(res.body).includes(text), text);
      }
    }
  });

  it('status: the app, its commit, the health check and the switches as on or off', async () => {
    const res = await admin.as('GET', '/api/admin/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.app, 'inner-circle');
    assert.equal(res.body.health, 'ok');
    assert.deepEqual(res.body.switches, [
      { name: 'Listing photos (R2)', on: false },
      { name: 'Waypoint sign-in', on: true },
    ]);
    const text = JSON.stringify(res.body);
    for (const secret of ['test-secret', 'SECRET']) assert.ok(!text.includes(secret));
  });
});

describe('admin gate', () => {
  it('sign-in and /profile flag the admin', async () => {
    assert.equal(admin.user.is_admin, true);
    assert.equal((await admin.as('GET', '/api/auth/profile')).body.user.is_admin, true);
    assert.equal(owner.user.is_admin, false);
  });

  it('no token is 401, a signed-in non-admin is 403', async () => {
    for (const url of ROUTES) {
      assert.equal((await app.request('GET', url)).status, 401, url);
      const res = await owner.as('GET', url);
      assert.equal(res.status, 403, url);
      assert.equal(res.body.error, 'Admins only');
    }
  });

  it('there is nothing to write to', async () => {
    for (const url of ROUTES) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        assert.equal((await admin.as(method, url, {})).status, 404, `${method} ${url}`);
      }
    }
  });

  it('the admin still has no member powers in circles they are not in', async () => {
    assert.equal((await admin.as('GET', `/api/circles/${family.id}`)).status, 403);
    assert.equal((await admin.as('GET', `/api/listings?circle_id=${family.id}`)).status, 403);
  });
});

describe('admin lists', () => {
  it('users page at 50, newest first, with counts', async () => {
    const first = await admin.as('GET', '/api/admin/users');
    assert.equal(first.status, 200);
    assert.equal(first.body.total, 63);
    assert.equal(first.body.page_size, 50);
    assert.equal(first.body.items.length, 50);
    const second = await admin.as('GET', '/api/admin/users?page=2');
    assert.equal(second.body.page, 2);
    assert.equal(second.body.items.length, 13);
    const ids = new Set([...first.body.items, ...second.body.items].map((u) => u.central_user_id));
    assert.equal(ids.size, 63);
    assert.deepEqual((await admin.as('GET', '/api/admin/users?page=3')).body.items, []);

    const me = second.body.items.find((u) => u.central_user_id === owner.user.central_user_id)
      ?? first.body.items.find((u) => u.central_user_id === owner.user.central_user_id);
    assert.equal(me.circle_count, 1);
    assert.equal(me.listing_count, 2);
  });

  it('a bad page or filter is 400', async () => {
    for (const url of [
      '/api/admin/users?page=0', '/api/admin/users?page=abc', '/api/admin/users?page=1.5',
      '/api/admin/members?circle_id=x', '/api/admin/listings?user_id=99999999999',
    ]) {
      assert.equal((await admin.as('GET', url)).status, 400, url);
    }
  });

  it('user search matches names, emails and ids, with % and _ taken literally', async () => {
    const res = await admin.as('GET', '/api/admin/users?q=bulk0');
    assert.equal(res.body.total, 9);
    assert.ok(res.body.items.every((u) => u.username.startsWith('bulk0')));
    assert.equal((await admin.as('GET', '/api/admin/users?q=ADMIN@EXAMPLE')).body.items[0].username, 'siteadmin');
    assert.equal((await admin.as('GET', '/api/admin/users?q=5007')).body.items[0].username, 'bulk07');
    assert.equal((await admin.as('GET', '/api/admin/users?q=bulk%25')).body.total, 0);
    assert.equal((await admin.as('GET', '/api/admin/users?q=bulk_1')).body.total, 0);
  });

  it('circles list every circle without its join code', async () => {
    const res = await admin.as('GET', '/api/admin/circles');
    assert.equal(res.body.total, 2);
    const garden = res.body.items.find((c) => c.id === family.id);
    assert.equal(garden.member_count, 2);
    assert.equal(garden.listing_count, 2);
    assert.equal(garden.active_listing_count, 1);
    assert.equal(garden.created_by_username, owner.user.username);
    assert.equal('join_code' in garden, false);
    assert.equal((await admin.as('GET', '/api/admin/circles?q=garden')).body.total, 1);
    assert.equal((await admin.as('GET', `/api/admin/circles?user_id=${friend.user.central_user_id}`)).body.total, 2);
    assert.equal((await admin.as('GET', `/api/admin/circles?user_id=${owner.user.central_user_id}`)).body.total, 1);
  });

  it('members filter by circle and user', async () => {
    const res = await admin.as('GET', `/api/admin/members?circle_id=${family.id}`);
    assert.equal(res.body.total, 2);
    assert.deepEqual(res.body.items.map((m) => m.role).sort(), ['admin', 'member']);
    assert.equal((await admin.as('GET', `/api/admin/members?user_id=${friend.user.central_user_id}`)).body.total, 2);
    assert.equal((await admin.as('GET', '/api/admin/members?q=book swap')).body.total, 1);
  });

  it('listings include inactive ones and search titles and tags', async () => {
    const res = await admin.as('GET', '/api/admin/listings');
    assert.equal(res.body.total, 3);
    assert.equal(res.body.items.find((l) => l.title === 'Old rake').active, false);
    assert.equal(res.body.items.find((l) => l.id === book.id).request_count, 1);
    assert.equal((await admin.as('GET', '/api/admin/listings?q=outdoor')).body.items[0].id, book.id);
    assert.equal((await admin.as('GET', `/api/admin/listings?circle_id=${family.id}`)).body.total, 2);
  });

  it('requests show both sides and search the message', async () => {
    const res = await admin.as('GET', '/api/admin/requests?q=saturday');
    assert.equal(res.body.total, 1);
    const [r] = res.body.items;
    assert.equal(r.from_username, friend.user.username);
    assert.equal(r.to_username, owner.user.username);
    assert.equal(r.listing_title, 'Hedge trimmer');
    assert.equal(r.status, 'pending');
    assert.equal((await admin.as('GET', `/api/admin/requests?user_id=${owner.user.central_user_id}`)).body.total, 1);
    assert.equal((await admin.as('GET', '/api/admin/requests?q=nothing like it')).body.total, 0);
  });

  it('no admin answer carries a join code', async () => {
    for (const url of ROUTES) {
      const text = JSON.stringify((await admin.as('GET', url)).body);
      assert.equal(text.includes('join_code'), false, url);
      for (const code of joinCodes) assert.equal(text.includes(code), false, url);
    }
  });

  // last: it changes the counts the tests above read
  it('a listing whose owner left the circle is still listed, marked, and not counted as active', async () => {
    const { listing } = (await friend.as('POST', '/api/listings', { circle_id: family.id, kind: 'have', title: 'Wheelbarrow' })).body;
    await friend.as('DELETE', `/api/circles/${family.id}/leave`);
    const { items } = (await admin.as('GET', `/api/admin/listings?circle_id=${family.id}`)).body;
    assert.equal(items.find((l) => l.id === listing.id).owner_in_circle, false);
    assert.equal(items.find((l) => l.id === book.id).owner_in_circle, true);
    const garden = (await admin.as('GET', '/api/admin/circles?q=garden')).body.items[0];
    assert.equal(garden.listing_count, 3);
    assert.equal(garden.active_listing_count, 1);
  });
});
