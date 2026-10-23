// API tests against the real server, a real (in-memory) Postgres and a stand-in Waypoint.
// They pin down how the app behaves today: sign-in, circles and join codes, listings with
// owner checks, requests between members, malformed ids, and the server surviving bad input.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { startApp, JWT_SECRET, CLIENT_ID, APP_BASE_URL } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

const MISSING = 999999;
const INT4_MAX = 2147483647; // the largest Postgres INTEGER
const INT4_MIN = -2147483648;
const HUGE = 99999999999;

/** A circle made by a new user. Returns the owner and the circle. */
async function newCircle(name = 'Family') {
  const owner = await app.user();
  const res = await owner.as('POST', '/api/circles', { name, description: 'Close family' });
  assert.equal(res.status, 200);
  return { owner, circle: res.body.circle };
}

/** A second user who joins the circle by its code. */
async function joiner(circle) {
  const g = await app.user();
  const res = await g.as('POST', '/api/circles/join', { join_code: circle.join_code });
  assert.equal(res.status, 200);
  return g;
}

const drill = { kind: 'have', category: 'item', title: 'Cordless drill', description: 'With bits', tags: ['tools'] };

describe('auth', () => {
  it('rejects every protected route without a token', async () => {
    const routes = [
      ['GET', '/api/auth/profile'],
      ['GET', '/api/circles'],
      ['POST', '/api/circles'],
      ['POST', '/api/circles/join'],
      ['GET', '/api/circles/1'],
      ['DELETE', '/api/circles/1/leave'],
      ['GET', '/api/listings?circle_id=1'],
      ['GET', '/api/listings/mine'],
      ['POST', '/api/listings'],
      ['PUT', '/api/listings/1'],
      ['DELETE', '/api/listings/1'],
      ['GET', '/api/requests'],
      ['POST', '/api/requests'],
      ['PUT', '/api/requests/1'],
    ];
    for (const [method, url] of routes) {
      const res = await app.request(method, url);
      assert.equal(res.status, 401, `${method} ${url}`);
      assert.equal(res.body.error, 'No token provided');
    }
  });

  it('rejects a bad token', async () => {
    const forged = jwt.sign({ central_user_id: 1000, username: 'x' }, 'not-the-secret');
    const expired = jwt.sign({ central_user_id: 1000, username: 'x', exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET);
    for (const token of [forged, expired, 'not-a-jwt']) {
      const res = await app.request('GET', '/api/circles', { token });
      assert.equal(res.status, 401);
      assert.equal(res.body.error, 'Invalid token');
    }
  });

  it('rejects a non-Bearer header', async () => {
    const res = await fetch(`${app.base}/api/circles`, { headers: { Authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } });
    assert.equal(res.status, 401);
  });

  it('rejects a valid token for a profile that does not exist', async () => {
    const token = jwt.sign({ central_user_id: MISSING, username: 'ghost' }, JWT_SECRET);
    const res = await app.request('GET', '/api/circles', { token });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'User not found');
  });

  it('reports SSO as enabled without a token', async () => {
    const res = await app.request('GET', '/api/auth/config');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ssoEnabled: true, photos: false });
  });

  it('a sign-in mirrors the central account and issues a working token', async () => {
    const g = await app.user();
    assert.ok(g.token);
    assert.match(g.user.username, /^user\d+$/);
    assert.match(g.user.email, /^user\d+@example\.test$/);
    const decoded = jwt.verify(g.token, JWT_SECRET);
    assert.equal(decoded.central_user_id, g.user.central_user_id);

    const profile = await g.as('GET', '/api/auth/profile');
    assert.equal(profile.status, 200);
    assert.equal(profile.body.user.central_user_id, g.user.central_user_id);
    assert.equal(profile.body.user.is_admin, false);
  });

  it('register and login go through Waypoint', async () => {
    const reg = await app.request('POST', '/api/auth/register', {
      body: { username: 'ann', email: 'ann@example.test', password: 'pw-ann', first_name: 'Ann', last_name: 'Lee' },
    });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.user.username, 'ann');

    const again = await app.request('POST', '/api/auth/register', { body: { username: 'ann', email: 'ann@example.test', password: 'pw' } });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'Email already registered');

    const login = await app.request('POST', '/api/auth/login', { body: { email: 'ann@example.test', password: 'pw-ann' } });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.central_user_id, reg.body.user.central_user_id);

    const wrong = await app.request('POST', '/api/auth/login', { body: { email: 'ann@example.test', password: 'nope' } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'Invalid email or password');
  });

  it('the SSO callback exchanges a code and updates the mirrored profile', async () => {
    const account = { central_user_id: 5000, username: 'sam', email: 'sam@example.test', first_name: 'Sam', last_name: 'Ng' };
    const first = await app.request('POST', '/api/auth/sso-callback', { body: { code: app.waypoint.issueCode(account) } });
    assert.equal(first.status, 200);
    assert.equal(first.body.user.username, 'sam');

    const renamed = { ...account, username: 'samuel' };
    const second = await app.request('POST', '/api/auth/sso-callback', { body: { code: app.waypoint.issueCode(renamed) } });
    assert.equal(second.status, 200);
    assert.equal(second.body.user.username, 'samuel');
    const { rows } = await app.db.query('SELECT username FROM profiles WHERE central_user_id = 5000');
    assert.deepEqual(rows, [{ username: 'samuel' }]);

    const bad = await app.request('POST', '/api/auth/sso-callback', { body: { code: 'made-up' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_grant');
  });

  it('a sign-in answers with the names it just stored', async () => {
    const account = { central_user_id: 5100, username: 'kim', email: 'kim@example.test', first_name: 'Kim', last_name: 'Ro' };
    await app.request('POST', '/api/auth/sso-callback', { body: { code: app.waypoint.issueCode(account) } });
    const renamed = { ...account, first_name: 'Kimberly', last_name: 'Rowe' };
    const again = await app.request('POST', '/api/auth/sso-callback', { body: { code: app.waypoint.issueCode(renamed) } });
    assert.equal(again.status, 200);
    assert.equal(again.body.user.first_name, 'Kimberly');
    assert.equal(again.body.user.last_name, 'Rowe');
    assert.equal(again.body.user.is_admin, false);
  });

  it('first sign-ins for the same account at once all succeed and make one profile', async () => {
    const account = { central_user_id: 5200, username: 'lee', email: null, first_name: 'Lee', last_name: '' };
    const codes = Array.from({ length: 6 }, () => app.waypoint.issueCode(account));
    const results = await Promise.all(codes.map((code) => app.request('POST', '/api/auth/sso-callback', { body: { code } })));
    assert.deepEqual(results.map((r) => r.status), codes.map(() => 200), JSON.stringify(results.map((r) => r.body.error)));
    assert.ok(results.every((r) => r.body.user.central_user_id === 5200 && r.body.token));
    const { rows } = await app.db.query('SELECT COUNT(*)::int AS n FROM profiles WHERE central_user_id = 5200');
    assert.equal(rows[0].n, 1);
  });

  it('SSO login redirects to Waypoint with every param encoded', async () => {
    const state = 'abc&client_id=evil&redirect_uri=http://evil.test';
    const res = await fetch(`${app.base}/api/auth/sso/login?state=${encodeURIComponent(state)}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const to = new URL(res.headers.get('location'));
    assert.equal(`${to.origin}${to.pathname}`, `${app.waypoint.url}/oauth/authorize`);
    assert.deepEqual(to.searchParams.getAll('client_id'), [CLIENT_ID]);
    assert.deepEqual(to.searchParams.getAll('redirect_uri'), [`${APP_BASE_URL}/auth/callback`]);
    assert.equal(to.searchParams.get('state'), state);
  });
});

describe('circles', () => {
  it('needs a name', async () => {
    const g = await app.user();
    const res = await g.as('POST', '/api/circles', { description: 'no name' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Name required');
  });

  it('a name or description Postgres could not store is a plain 400, and nothing is made', async () => {
    const g = await app.user();
    const count = async () => (await app.db.query('SELECT COUNT(*)::int AS n FROM circles')).rows[0].n;
    const start = await count();
    const cases = [
      [{ name: 'x'.repeat(256) }, 'Name must be 255 characters or fewer'],
      [{ name: '😀'.repeat(256) }, 'Name must be 255 characters or fewer'],
      [{ name: 'Bad\u0000name' }, "Name has a character that can't be saved"],
      [{ name: 12 }, 'Name must be text'],
      [{ name: { $ne: '' } }, 'Name must be text'],
      [{ name: 'Fine', description: 'Bad\u0000text' }, "Description has a character that can't be saved"],
      [{ name: 'Fine', description: ['x'] }, 'Description must be text'],
    ];
    for (const [body, error] of cases) {
      const res = await g.as('POST', '/api/circles', body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.deepEqual(res.body, { error });
    }
    assert.equal(await count(), start);
  });

  it('a name of exactly 255 characters is fine, counted in characters rather than bytes', async () => {
    const g = await app.user();
    for (const name of ['x'.repeat(255), '😀'.repeat(255)]) {
      const res = await g.as('POST', '/api/circles', { name });
      assert.equal(res.status, 200, name.slice(0, 5));
      assert.equal(res.body.circle.name, name);
    }
  });

  it('the creator becomes the admin and sees the circle in their list', async () => {
    const { owner, circle } = await newCircle('Cousins');
    assert.equal(circle.name, 'Cousins');
    assert.equal(circle.created_by, owner.user.central_user_id);
    assert.match(circle.join_code, /^[0-9A-Z]{6}$/);

    const list = await owner.as('GET', '/api/circles');
    assert.equal(list.status, 200);
    assert.equal(list.body.circles.length, 1);
    assert.equal(list.body.circles[0].id, circle.id);
    assert.equal(list.body.circles[0].role, 'admin');
    assert.equal(list.body.circles[0].member_count, 1);
    assert.equal(list.body.circles[0].listing_count, 0);
  });

  it('join by code: any case, idempotent, members only see it', async () => {
    const { owner, circle } = await newCircle();
    const other = await app.user();
    const outsider = await app.user();

    assert.equal((await other.as('GET', `/api/circles/${circle.id}`)).status, 403);

    const joined = await other.as('POST', '/api/circles/join', { join_code: circle.join_code.toLowerCase() });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.circle.id, circle.id);

    // Joining twice changes nothing.
    assert.equal((await other.as('POST', '/api/circles/join', { join_code: circle.join_code })).status, 200);

    const view = await other.as('GET', `/api/circles/${circle.id}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.circle.name, 'Family');
    const roles = Object.fromEntries(view.body.members.map((m) => [m.central_user_id, m.role]));
    assert.deepEqual(roles, { [owner.user.central_user_id]: 'admin', [other.user.central_user_id]: 'member' });
    assert.ok(view.body.members.every((m) => m.username));

    const list = await owner.as('GET', '/api/circles');
    assert.equal(list.body.circles[0].member_count, 2);

    const blocked = await outsider.as('GET', `/api/circles/${circle.id}`);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'Not a member');
    assert.deepEqual((await outsider.as('GET', '/api/circles')).body.circles, []);
  });

  it('a wrong, missing or non-string join code is 404', async () => {
    await newCircle();
    const g = await app.user();
    for (const body of [{ join_code: 'ZZZZZZZ' }, {}, { join_code: { $ne: '' } }, { join_code: 12 }]) {
      const res = await g.as('POST', '/api/circles/join', body);
      assert.equal(res.status, 404, JSON.stringify(body));
      assert.equal(res.body.error, 'Circle not found');
    }
    assert.deepEqual((await g.as('GET', '/api/circles')).body.circles, []);
  });

  it('a circle that does not exist reads as not a member', async () => {
    const g = await app.user();
    const res = await g.as('GET', `/api/circles/${MISSING}`);
    assert.equal(res.status, 403);
  });

  it('leave removes the membership; leaving again is a no-op', async () => {
    const { owner, circle } = await newCircle();
    const other = await joiner(circle);

    const left = await other.as('DELETE', `/api/circles/${circle.id}/leave`);
    assert.equal(left.status, 200);
    assert.deepEqual(left.body, { ok: true });
    assert.equal((await other.as('GET', `/api/circles/${circle.id}`)).status, 403);
    assert.deepEqual((await other.as('GET', '/api/circles')).body.circles, []);
    assert.equal((await owner.as('GET', '/api/circles')).body.circles[0].member_count, 1);

    assert.equal((await other.as('DELETE', `/api/circles/${circle.id}/leave`)).status, 200);
  });
});

describe('listings', () => {
  it('listing a circle needs circle_id and membership', async () => {
    const { circle } = await newCircle();
    const outsider = await app.user();
    const none = await outsider.as('GET', '/api/listings');
    assert.equal(none.status, 400);
    assert.equal(none.body.error, 'circle_id required');
    const blocked = await outsider.as('GET', `/api/listings?circle_id=${circle.id}`);
    assert.equal(blocked.status, 403);
  });

  it('create checks its input and membership', async () => {
    const { owner, circle } = await newCircle();
    const outsider = await app.user();
    const cases = [
      [{ ...drill, circle_id: circle.id, title: '' }, 'circle_id and title required'],
      [{ ...drill }, 'circle_id and title required'],
      [{ ...drill, circle_id: circle.id, kind: 'skill' }, 'Invalid kind'],
      [{ ...drill, circle_id: circle.id, kind: undefined }, 'Invalid kind'],
      [{ ...drill, circle_id: circle.id, category: 'weapons' }, 'Invalid category'],
      [{ ...drill, circle_id: circle.id, tags: 'tools' }, 'Tags must be a list of strings'],
      [{ ...drill, circle_id: circle.id, tags: [1, 2] }, 'Tags must be a list of strings'],
    ];
    for (const [body, error] of cases) {
      const res = await owner.as('POST', '/api/listings', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error, error);
    }
    const blocked = await outsider.as('POST', '/api/listings', { ...drill, circle_id: circle.id });
    assert.equal(blocked.status, 403);
    assert.deepEqual((await owner.as('GET', '/api/listings/mine')).body.listings, []);
  });

  it('a title or text Postgres could not store is a plain 400 on create and edit', async () => {
    const { owner, circle } = await newCircle();
    const id = (await owner.as('POST', '/api/listings', { ...drill, circle_id: circle.id })).body.listing.id;
    const cases = [
      [{ title: 'x'.repeat(256) }, 'Title must be 255 characters or fewer'],
      [{ title: '😀'.repeat(256) }, 'Title must be 255 characters or fewer'],
      [{ title: 'Bad\u0000title' }, "Title has a character that can't be saved"],
      [{ description: 'Bad\u0000text' }, "Description has a character that can't be saved"],
      [{ availability: ['weekends'] }, 'Availability must be text'],
      [{ tags: ['ok', 'bad\u0000tag'] }, 'Tags must be a list of strings'],
    ];
    for (const [change, error] of cases) {
      const created = await owner.as('POST', '/api/listings', { ...drill, circle_id: circle.id, ...change });
      assert.equal(created.status, 400, JSON.stringify(change).slice(0, 80));
      assert.deepEqual(created.body, { error });
      const edited = await owner.as('PUT', `/api/listings/${id}`, change);
      assert.equal(edited.status, 400, JSON.stringify(change).slice(0, 80));
      assert.deepEqual(edited.body, { error });
    }
    // The create above that was refused made nothing, and the edits changed nothing.
    const mine = (await owner.as('GET', '/api/listings/mine')).body.listings;
    assert.deepEqual(mine.map((l) => [l.id, l.title]), [[id, 'Cordless drill']]);
  });

  it('a title of exactly 255 characters is fine, counted in characters rather than bytes', async () => {
    const { owner, circle } = await newCircle();
    for (const title of ['x'.repeat(255), '😀'.repeat(255)]) {
      const created = await owner.as('POST', '/api/listings', { ...drill, circle_id: circle.id, title });
      assert.equal(created.status, 200, title.slice(0, 5));
      assert.equal(created.body.listing.title, title);
      const edited = await owner.as('PUT', `/api/listings/${created.body.listing.id}`, { title });
      assert.equal(edited.status, 200);
    }
  });

  it('members create and see listings; defaults fill in; kind filters', async () => {
    const { owner, circle } = await newCircle();
    const other = await joiner(circle);

    const created = await owner.as('POST', '/api/listings', { ...drill, circle_id: String(circle.id) });
    assert.equal(created.status, 200);
    assert.equal(created.body.listing.circle_id, circle.id);
    assert.equal(created.body.listing.central_user_id, owner.user.central_user_id);
    assert.deepEqual(created.body.listing.tags, ['tools']);
    assert.equal(created.body.listing.active, true);

    const need = await other.as('POST', '/api/listings', { circle_id: circle.id, kind: 'need', title: 'Ride to the airport' });
    assert.equal(need.status, 200);
    assert.equal(need.body.listing.category, 'item');
    assert.equal(need.body.listing.description, '');
    assert.deepEqual(need.body.listing.tags, []);

    const all = await owner.as('GET', `/api/listings?circle_id=${circle.id}`);
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.listings.map((l) => l.title).sort(), ['Cordless drill', 'Ride to the airport']);
    assert.ok(all.body.listings.every((l) => l.username));

    const needs = await owner.as('GET', `/api/listings?circle_id=${circle.id}&kind=need`);
    assert.deepEqual(needs.body.listings.map((l) => l.title), ['Ride to the airport']);
    // An unknown kind is ignored rather than rejected.
    const unknown = await owner.as('GET', `/api/listings?circle_id=${circle.id}&kind=skill`);
    assert.equal(unknown.body.listings.length, 2);

    assert.equal((await owner.as('GET', '/api/circles')).body.circles[0].listing_count, 2);
  });

  it('only the owner can update; fields not sent stay as they were', async () => {
    const { owner, circle } = await newCircle();
    const other = await joiner(circle);
    const id = (await other.as('POST', '/api/listings', { ...drill, circle_id: circle.id })).body.listing.id;

    // Not even the circle admin can edit someone else's listing.
    const notYours = await owner.as('PUT', `/api/listings/${id}`, { title: 'Mine now' });
    assert.equal(notYours.status, 403);
    assert.equal(notYours.body.error, 'Not your listing');

    assert.equal((await other.as('PUT', `/api/listings/${id}`, { kind: 'skill' })).status, 400);
    assert.equal((await other.as('PUT', `/api/listings/${id}`, { category: 'weapons' })).status, 400);
    assert.equal((await other.as('PUT', `/api/listings/${id}`, { tags: 'x' })).status, 400);

    const updated = await other.as('PUT', `/api/listings/${id}`, { title: 'Drill and driver', tags: ['tools', 'diy'] });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.listing.title, 'Drill and driver');
    assert.deepEqual(updated.body.listing.tags, ['tools', 'diy']);
    assert.equal(updated.body.listing.description, 'With bits');
    assert.equal(updated.body.listing.kind, 'have');
  });

  it('an edit cannot blank the title or set active to anything but true or false', async () => {
    const { owner, circle } = await newCircle();
    const id = (await owner.as('POST', '/api/listings', { ...drill, circle_id: circle.id })).body.listing.id;
    for (const title of ['', '   ', 12, ['x']]) {
      const res = await owner.as('PUT', `/api/listings/${id}`, { title });
      assert.equal(res.status, 400, JSON.stringify(title));
      assert.equal(res.body.error, 'Title required');
    }
    for (const active of ['maybe', 'false', 0, {}]) {
      const res = await owner.as('PUT', `/api/listings/${id}`, { active });
      assert.equal(res.status, 400, JSON.stringify(active));
      assert.equal(res.body.error, 'active must be true or false');
    }
    const { rows } = await app.db.query('SELECT title, active FROM listings WHERE id = $1', [id]);
    assert.deepEqual(rows, [{ title: 'Cordless drill', active: true }]);
    // null still means "leave it as it is".
    const kept = await owner.as('PUT', `/api/listings/${id}`, { title: null, active: null, description: 'Bits included' });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.listing.title, 'Cordless drill');
    assert.equal(kept.body.listing.active, true);
  });

  it('a deactivated listing leaves the circle list but stays in mine', async () => {
    const { owner, circle } = await newCircle('Neighbours');
    const id = (await owner.as('POST', '/api/listings', { ...drill, circle_id: circle.id })).body.listing.id;

    const off = await owner.as('PUT', `/api/listings/${id}`, { active: false });
    assert.equal(off.body.listing.active, false);
    assert.deepEqual((await owner.as('GET', `/api/listings?circle_id=${circle.id}`)).body.listings, []);
    assert.equal((await owner.as('GET', '/api/circles')).body.circles[0].listing_count, 0);

    const mine = await owner.as('GET', '/api/listings/mine');
    assert.equal(mine.body.listings.length, 1);
    assert.equal(mine.body.listings[0].circle_name, 'Neighbours');
    assert.equal(mine.body.listings[0].active, false);
  });

  it('only the owner can delete', async () => {
    const { owner, circle } = await newCircle();
    const other = await joiner(circle);
    const id = (await owner.as('POST', '/api/listings', { ...drill, circle_id: circle.id })).body.listing.id;

    assert.equal((await other.as('DELETE', `/api/listings/${id}`)).status, 403);
    const del = await owner.as('DELETE', `/api/listings/${id}`);
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { ok: true });
    assert.equal((await owner.as('DELETE', `/api/listings/${id}`)).status, 404);
    assert.equal((await owner.as('PUT', `/api/listings/${id}`, { title: 'x' })).status, 404);
  });

  it('ownership is the only check on edits: an owner who left the circle can still edit', async () => {
    // Today's behaviour: update and delete look at the owner, not at current membership.
    const { circle } = await newCircle();
    const other = await joiner(circle);
    const id = (await other.as('POST', '/api/listings', { ...drill, circle_id: circle.id })).body.listing.id;
    await other.as('DELETE', `/api/circles/${circle.id}/leave`);

    assert.equal((await other.as('GET', `/api/listings?circle_id=${circle.id}`)).status, 403);
    assert.equal((await other.as('PUT', `/api/listings/${id}`, { title: 'After leaving' })).status, 200);
  });
});

describe('requests', () => {
  /** Owner posts a listing in a circle; a member and an outsider are ready to ask for it. */
  async function setup() {
    const { owner, circle } = await newCircle();
    const member = await joiner(circle);
    const outsider = await app.user();
    const listing = (await owner.as('POST', '/api/listings', { ...drill, circle_id: circle.id })).body.listing;
    return { owner, member, outsider, circle, listing };
  }

  it('a member can ask for a listing; the owner and outsiders cannot', async () => {
    const { owner, member, outsider, listing } = await setup();

    const own = await owner.as('POST', '/api/requests', { listing_id: listing.id });
    assert.equal(own.status, 400);
    assert.equal(own.body.error, 'Cannot request your own listing');

    const blocked = await outsider.as('POST', '/api/requests', { listing_id: listing.id, message: 'Hi' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'Not a member of this circle');

    const missing = await member.as('POST', '/api/requests', { listing_id: MISSING });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'Listing not found');

    const made = await member.as('POST', '/api/requests', { listing_id: listing.id, message: 'Can I borrow it Saturday?' });
    assert.equal(made.status, 200);
    assert.equal(made.body.request.status, 'pending');
    assert.equal(made.body.request.from_user_id, member.user.central_user_id);
    assert.equal(made.body.request.to_user_id, owner.user.central_user_id);
    assert.equal(made.body.request.message, 'Can I borrow it Saturday?');
  });

  it('a message Postgres cannot store is a 400, not a 500, and makes no request', async () => {
    const { owner, member, listing } = await setup();
    for (const [message, error] of [
      ['Bad\u0000text', "Message has a character that can't be saved"],
      [{ not: 'text' }, 'Message must be text'],
    ]) {
      const res = await member.as('POST', '/api/requests', { listing_id: listing.id, message });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error, error);
    }
    assert.deepEqual((await owner.as('GET', '/api/requests')).body.requests, []);
  });

  it('incoming and outgoing lists', async () => {
    const { owner, member, listing } = await setup();
    const id = (await member.as('POST', '/api/requests', { listing_id: listing.id })).body.request.id;

    const incoming = await owner.as('GET', '/api/requests?direction=incoming');
    assert.deepEqual(incoming.body.requests.map((r) => r.id), [id]);
    assert.equal(incoming.body.requests[0].listing_title, 'Cordless drill');
    assert.equal(incoming.body.requests[0].listing_kind, 'have');
    assert.equal(incoming.body.requests[0].from_username, member.user.username);
    assert.equal(incoming.body.requests[0].to_username, owner.user.username);

    // Incoming is the default, and an unknown direction falls back to it.
    assert.deepEqual((await owner.as('GET', '/api/requests')).body.requests.map((r) => r.id), [id]);
    assert.deepEqual((await owner.as('GET', '/api/requests?direction=sideways')).body.requests.map((r) => r.id), [id]);

    assert.deepEqual((await member.as('GET', '/api/requests?direction=outgoing')).body.requests.map((r) => r.id), [id]);
    assert.deepEqual((await member.as('GET', '/api/requests')).body.requests, []);
    assert.deepEqual((await owner.as('GET', '/api/requests?direction=outgoing')).body.requests, []);
  });

  const statusOf = async (id) => (await app.db.query('SELECT status FROM requests WHERE id = $1', [id])).rows[0].status;

  it('only the listing owner accepts, declines or completes', async () => {
    const { owner, member, outsider, listing } = await setup();
    const id = (await member.as('POST', '/api/requests', { listing_id: listing.id })).body.request.id;

    for (const status of ['maybe', 'pending', undefined, 7]) {
      const invalid = await owner.as('PUT', `/api/requests/${id}`, { status });
      assert.equal(invalid.status, 400, String(status));
      assert.equal(invalid.body.error, 'Invalid status');
    }

    // The person who asked can't answer their own request, whatever the status.
    for (const status of ['accepted', 'declined', 'completed']) {
      const sender = await member.as('PUT', `/api/requests/${id}`, { status });
      assert.equal(sender.status, 403, status);
      assert.equal(sender.body.error, 'Only the listing owner can accept, decline or complete a request');
    }

    const stranger = await outsider.as('PUT', `/api/requests/${id}`, { status: 'completed' });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.error, 'Forbidden');
    assert.equal((await outsider.as('PUT', `/api/requests/${id}`, { status: 'cancelled' })).status, 403);
    assert.equal(await statusOf(id), 'pending');

    const accepted = await owner.as('PUT', `/api/requests/${id}`, { status: 'accepted' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.request.status, 'accepted');

    // Completing is the owner's too.
    assert.equal((await member.as('PUT', `/api/requests/${id}`, { status: 'completed' })).status, 403);
    const completed = await owner.as('PUT', `/api/requests/${id}`, { status: 'completed' });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.request.status, 'completed');
    assert.equal(await statusOf(id), 'completed');
  });

  it('the person who asked can only cancel, and only while the request is open', async () => {
    const { owner, member, listing } = await setup();
    const open = async () => (await member.as('POST', '/api/requests', { listing_id: listing.id })).body.request.id;

    // The owner can't cancel on their behalf.
    const first = await open();
    const notOwner = await owner.as('PUT', `/api/requests/${first}`, { status: 'cancelled' });
    assert.equal(notOwner.status, 403);
    assert.equal(notOwner.body.error, 'Only the person who asked can cancel a request');

    // Pending, then accepted: both can be cancelled.
    const cancelled = await member.as('PUT', `/api/requests/${first}`, { status: 'cancelled' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.request.status, 'cancelled');
    const second = await open();
    await owner.as('PUT', `/api/requests/${second}`, { status: 'accepted' });
    assert.equal((await member.as('PUT', `/api/requests/${second}`, { status: 'cancelled' })).status, 200);
    assert.equal(await statusOf(second), 'cancelled');

    // A cancelled request is closed for both: cancelling again, or answering it, is a 409.
    const again = await member.as('PUT', `/api/requests/${first}`, { status: 'cancelled' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'This request is already closed');
    for (const status of ['accepted', 'declined', 'completed']) {
      const late = await owner.as('PUT', `/api/requests/${first}`, { status });
      assert.equal(late.status, 409, status);
      assert.equal(late.body.error, 'This request was cancelled');
    }
    assert.equal(await statusOf(first), 'cancelled');

    // Declined and completed requests can't be taken back either.
    for (const status of ['declined', 'completed']) {
      const id = await open();
      await owner.as('PUT', `/api/requests/${id}`, { status });
      assert.equal((await member.as('PUT', `/api/requests/${id}`, { status: 'cancelled' })).status, 409, status);
      assert.equal(await statusOf(id), status);
    }
  });

  it('a request on an inactive listing is refused, and works again once it is active', async () => {
    const { owner, member, outsider, listing } = await setup();
    const earlier = await member.as('POST', '/api/requests', { listing_id: listing.id });
    assert.equal(earlier.status, 200);
    await owner.as('PUT', `/api/listings/${listing.id}`, { active: false });

    const res = await member.as('POST', '/api/requests', { listing_id: listing.id });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'This listing is no longer active');
    // Someone outside the circle still hears "not a member", not that the listing is hidden.
    const blocked = await outsider.as('POST', '/api/requests', { listing_id: listing.id });
    assert.equal(blocked.status, 403);
    // The request made before stays as it was, and the owner can still answer it.
    assert.equal(await statusOf(earlier.body.request.id), 'pending');
    assert.equal((await owner.as('PUT', `/api/requests/${earlier.body.request.id}`, { status: 'declined' })).status, 200);

    await owner.as('PUT', `/api/listings/${listing.id}`, { active: true });
    assert.equal((await member.as('POST', '/api/requests', { listing_id: listing.id })).status, 200);
  });

  it('one pending request per person per listing; a settled one frees the next', async () => {
    const { owner, member, circle, listing } = await setup();
    const other = await joiner(circle);
    const count = async () => (await app.db.query('SELECT COUNT(*)::int AS n FROM requests WHERE listing_id = $1', [listing.id])).rows[0].n;

    const first = await member.as('POST', '/api/requests', { listing_id: listing.id, message: 'Saturday?' });
    assert.equal(first.status, 200);
    for (let i = 0; i < 3; i++) {
      const repeat = await member.as('POST', '/api/requests', { listing_id: listing.id, message: 'Saturday?' });
      assert.equal(repeat.status, 409);
      assert.equal(repeat.body.error, 'You already have a pending request for this listing');
    }
    assert.equal(await count(), 1);

    // Someone else may ask, and the same person may ask for a different listing.
    assert.equal((await other.as('POST', '/api/requests', { listing_id: listing.id })).status, 200);
    const ladder = (await owner.as('POST', '/api/listings', { ...drill, circle_id: circle.id, title: 'Ladder' })).body.listing;
    assert.equal((await member.as('POST', '/api/requests', { listing_id: ladder.id })).status, 200);

    // Once the first is answered it no longer counts as pending...
    await owner.as('PUT', `/api/requests/${first.body.request.id}`, { status: 'declined' });
    const next = await member.as('POST', '/api/requests', { listing_id: listing.id });
    assert.equal(next.status, 200);
    assert.equal((await member.as('POST', '/api/requests', { listing_id: listing.id })).status, 409);
    // ...and neither does a cancelled one.
    await member.as('PUT', `/api/requests/${next.body.request.id}`, { status: 'cancelled' });
    assert.equal((await member.as('POST', '/api/requests', { listing_id: listing.id })).status, 200);
  });
});

describe('malformed ids', () => {
  it('answer 400, and well-formed ids that match nothing answer 404', async () => {
    const g = await app.user();
    const cases = [
      ['GET', '/api/circles/abc', undefined, 400],
      ['DELETE', '/api/circles/abc/leave', undefined, 400],
      ['GET', '/api/listings?circle_id=abc', undefined, 400],
      ['POST', '/api/listings', { circle_id: 'abc', kind: 'have', title: 'x' }, 400],
      ['PUT', '/api/listings/abc', { title: 'x' }, 400],
      ['DELETE', '/api/listings/abc', undefined, 400],
      ['PUT', `/api/listings/${MISSING}`, { title: 'x' }, 404],
      ['DELETE', `/api/listings/${MISSING}`, undefined, 404],
      ['POST', '/api/requests', { listing_id: 'abc' }, 400],
      ['POST', '/api/requests', {}, 400],
      ['POST', '/api/requests', { listing_id: MISSING }, 404],
      ['PUT', '/api/requests/abc', { status: 'accepted' }, 400],
      ['PUT', `/api/requests/${MISSING}`, { status: 'accepted' }, 404],
      // A fraction, or a number outside Postgres INTEGER, is malformed too: it never reaches
      // the database.
      ['GET', '/api/listings?circle_id=1.5', undefined, 400],
      ['GET', `/api/listings?circle_id=${HUGE}`, undefined, 400],
      ['GET', `/api/circles/${HUGE}`, undefined, 400],
      ['GET', `/api/circles/${INT4_MAX + 1}`, undefined, 400],
      ['GET', `/api/circles/${INT4_MIN - 1}`, undefined, 400],
      ['DELETE', `/api/circles/${HUGE}/leave`, undefined, 400],
      ['POST', '/api/listings', { circle_id: 1.5, kind: 'have', title: 'x' }, 400],
      ['POST', '/api/listings', { circle_id: HUGE, kind: 'have', title: 'x' }, 400],
      ['PUT', '/api/listings/1.5', { title: 'x' }, 400],
      ['PUT', `/api/listings/${HUGE}`, { title: 'x' }, 400],
      ['DELETE', `/api/listings/${HUGE}`, undefined, 400],
      ['POST', '/api/requests', { listing_id: 1.5 }, 400],
      ['POST', '/api/requests', { listing_id: HUGE }, 400],
      ['PUT', '/api/requests/1.5', { status: 'accepted' }, 400],
      ['PUT', `/api/requests/${HUGE}`, { status: 'accepted' }, 400],
      // The largest INTEGER is still well-formed and simply matches nothing.
      ['PUT', `/api/listings/${INT4_MAX}`, { title: 'x' }, 404],
      ['DELETE', `/api/listings/${INT4_MAX}`, undefined, 404],
      ['POST', '/api/requests', { listing_id: INT4_MAX }, 404],
      ['PUT', `/api/requests/${INT4_MAX}`, { status: 'accepted' }, 404],
    ];
    for (const [method, url, body, status] of cases) {
      const res = await g.as(method, url, body);
      assert.equal(res.status, status, `${method} ${url} ${JSON.stringify(body ?? '')}`);
      assert.equal(typeof res.body.error, 'string');
    }
    assert.ok(app.alive());
  });
});

describe('bad input does not take the server down', () => {
  it('malformed JSON is a 400 in JSON', async () => {
    const g = await app.user();
    const res = await app.request('POST', '/api/circles', { token: g.token, raw: '{"name": ' });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Bad request' });
  });

  /** Run `fn` with a table out of the way (renamed), so queries on it fail inside Postgres. */
  async function withTableMissing(table, fn) {
    await app.db.query(`ALTER TABLE ${table} RENAME TO ${table}_away`);
    try { return await fn(); } finally { await app.db.query(`ALTER TABLE ${table}_away RENAME TO ${table}`); }
  }

  it('a query Postgres rejects answers 500 without details, and the server keeps serving', async () => {
    const { owner, circle } = await newCircle();
    const res = await withTableMissing('listings', () => owner.as('POST', '/api/listings', { ...drill, circle_id: circle.id }));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Something went wrong' });

    assert.ok(app.alive());
    assert.equal((await app.request('GET', '/health')).status, 200);
    const ok = await owner.as('POST', '/api/listings', { ...drill, circle_id: circle.id });
    assert.equal(ok.status, 200);
  });

  it('a failed circle insert rolls back, answers 500 without details and leaves nothing behind', async () => {
    const g = await app.user();
    const count = async () => (await app.db.query('SELECT COUNT(*)::int AS n FROM circles')).rows[0].n;
    const start = await count();
    // The circle goes in first and the admin membership second; the second fails.
    const res = await withTableMissing('circle_members', () => g.as('POST', '/api/circles', { name: 'Half made' }));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: 'Something went wrong' });
    assert.equal(await count(), start);

    // The pooled connection that held the failed transaction still works.
    const next = await g.as('POST', '/api/circles', { name: 'Second try' });
    assert.equal(next.status, 200);
  });
});

describe('unknown API paths', () => {
  it('answer 404 in JSON, signed in or not, instead of the app page', async () => {
    const g = await app.user();
    const cases = [
      ['GET', '/api/nothing-here', undefined],
      ['POST', '/api/nothing-here', undefined],
      ['GET', '/api', undefined],
      ['GET', '/api/circles/1/members', g.token],
      ['PATCH', '/api/listings/1', g.token],
    ];
    for (const [method, url, token] of cases) {
      const res = await app.request(method, url, { token });
      assert.equal(res.status, 404, `${method} ${url}`);
      assert.deepEqual(res.body, { error: 'Not found' }, `${method} ${url}`);
    }
    // Routers that need a token still ask for it first.
    assert.equal((await app.request('GET', '/api/circles/1/members')).status, 401);
  });
});

describe('schema', () => {
  it('every foreign key column leads an index', async () => {
    // Postgres indexes the key a foreign key points at, not the column that holds it. Without
    // one, the lookups by that column and every delete of the row it names scan the table.
    const { rows } = await app.db.query(`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
         AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
       ORDER BY 1, 2`);
    assert.deepEqual(rows, []);
  });
});

describe('admin lists', () => {
  it('are closed to everyone while ADMIN_CENTRAL_USER_IDS is empty', async () => {
    const g = await app.user();
    assert.equal(g.user.is_admin, false);
    const res = await g.as('GET', '/api/admin/users');
    assert.equal(res.status, 403);
  });
});
