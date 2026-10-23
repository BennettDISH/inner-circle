// The guest sweep (services/guestSweep.js) against the real schema, in an in-memory Postgres.
// What it may take is exactly an idle guest and what only guests had a part in: every other
// row in every table is compared, before and after, and must be there unchanged.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { startWaypoint } from './fakeWaypoint.js';
import { checkGuests } from '../services/guestCheck.js';

// Waypoint is a stand-in (fakeWaypoint.js) that, unless a test says otherwise, calls every idle guest
// an unclaimed guest.
let waypoint;
before(async () => {
  waypoint = await startWaypoint();
  Object.assign(process.env, waypoint.env());
});
after(() => waypoint.close());
beforeEach(() => {
  waypoint.reset();
  Object.assign(process.env, waypoint.env()); // another test here may have pointed these elsewhere
});

let dbServer, db, sweepGuests, runGuestSweep;

before(async () => {
  const pglite = await PGlite.create();
  const port = 20000 + Math.floor(Math.random() * 20000);
  dbServer = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1', maxConnections: 8 });
  await dbServer.start();
  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const { initDb, default: pool } = await import('../config/db.js');
  await initDb();
  db = pool;
  ({ sweepGuests, runGuestSweep } = await import('../services/guestSweep.js'));
});

after(async () => {
  await db?.end().catch(() => {});
  await dbServer?.stop().catch(() => {});
});

const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

/** Every row of every table, as text, by table. */
async function everything() {
  const out = {};
  for (const { name } of await q(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)) {
    out[name] = (await q(`SELECT to_jsonb(t)::text AS row FROM "${name}" t`)).map((r) => r.row).sort();
  }
  return out;
}
/** What went, by table: the rows of `was` that `now` no longer has. Fails if any row changed. */
function gone(was, now) {
  const out = {};
  for (const [table, rows] of Object.entries(was)) {
    const left = new Set(now[table]);
    for (const row of now[table]) assert.ok(rows.includes(row), `${table}: a row changed or appeared: ${row}`);
    const went = rows.filter((r) => !left.has(r)).map((r) => JSON.parse(r));
    if (went.length) out[table] = went;
  }
  return out;
}
const ids = (rows, col = 'id') => (rows ?? []).map((r) => r[col]).sort((a, b) => a - b);
const sorted = (list) => [...list].sort((a, b) => a - b);

let n = 0;
const USERS = 'profiles';
/** A profile Waypoint's sign-in would make, last seen `days` ago. */
async function profile({ guest = false, name, days = 0 } = {}) {
  n += 1;
  const username = name ?? (guest ? `guest-swift-otter-${1000 + n}` : `player${n}`);
  return one(
    `INSERT INTO profiles (central_user_id, username, created_at, updated_at)
     VALUES ($1, $2, NOW() - ($3 || ' days')::interval, NOW() - ($3 || ' days')::interval) RETURNING *`,
    [500 + n, username, String(days)]);
}
const circle = async (maker) => {
  const c = await one(`INSERT INTO circles (name, join_code, created_by) VALUES ('Circle', $1, $2) RETURNING *`, [`CODE${n}x${Math.random()}`.slice(0, 20), maker.central_user_id]);
  await join(c, maker, 'owner');
  return c;
};
const join = (c, who, role = 'member') => q(`INSERT INTO circle_members (circle_id, central_user_id, role) VALUES ($1, $2, $3)`, [c.id, who.central_user_id, role]);
const listing = (c, who) => one(`INSERT INTO listings (circle_id, central_user_id, title) VALUES ($1, $2, 'A ladder') RETURNING *`, [c.id, who.central_user_id]);
const ask = (l, from) => one(`INSERT INTO requests (listing_id, from_user_id, to_user_id) VALUES ($1, $2, $3) RETURNING *`, [l.id, from.central_user_id, l.central_user_id]);

test('an idle guest goes with what only guests touched; an active guest, a real account and anything a real account has a part in stay', async () => {
  // a real account nobody has seen for over a year, with a circle of its own
  const real = await profile({ days: 400 });
  const realCircle = await circle(real);
  const realListing = await listing(realCircle, real);

  // 1. two idle guests in a circle of their own, with a listing and a request: all of it goes
  const idle = await profile({ guest: true, days: 40 });
  const idle2 = await profile({ guest: true, days: 35 });
  const idleCircle = await circle(idle);
  await join(idleCircle, idle2);
  const idleListing = await listing(idleCircle, idle);
  const idleAsk = await ask(idleListing, idle2);
  // 2. a guest still in use: stays, with its circle
  const active = await profile({ guest: true, days: 2 });
  await listing(await circle(active), active);
  // 3. an idle guest's circle the real account joined: the circle stays, so the guest does
  const hosted = await profile({ guest: true, days: 40 });
  await join(await circle(hosted), real);
  // 4. an idle guest that joined the real circle and listed there: stays, and so does all of it
  const visitor = await profile({ guest: true, days: 40 });
  await join(realCircle, visitor);
  await listing(realCircle, visitor);
  // 5. an idle guest that asked for the real account's ladder: stays, and so does the ask
  const asker = await profile({ guest: true, days: 40 });
  await join(realCircle, asker);
  await ask(realListing, asker);
  // 6. real accounts whose names only look a little like a guest's
  const lookalike = await profile({ name: 'guest-house', days: 400 });
  const lookalike2 = await profile({ name: 'guestly-otter-1234', days: 400 });

  const was = await everything();
  const r = await sweepGuests({ db, days: 30 });
  const went = gone(was, await everything());

  assert.deepEqual(Object.keys(went).sort(), ['circle_members', 'circles', 'listings', 'profiles', 'requests']);
  assert.deepEqual(ids(went.profiles), sorted([idle.id, idle2.id]));
  assert.deepEqual(ids(went.circles), [idleCircle.id]);
  assert.deepEqual(ids(went.circle_members, 'central_user_id'), sorted([idle.central_user_id, idle2.central_user_id]));
  assert.deepEqual(ids(went.listings), [idleListing.id]);
  assert.deepEqual(ids(went.requests), [idleAsk.id]);
  assert.deepEqual(r, { stale: 5, made: 1, removed: 2, kept: 3 });
  for (const p of [real, active, hosted, visitor, asker, lookalike, lookalike2]) {
    assert.ok(await one('SELECT 1 FROM profiles WHERE id = $1', [p.id]));
  }

  // a second run finds nothing more to take
  const again = await everything();
  assert.deepEqual(await sweepGuests({ db, days: 30 }), { stale: 3, made: 0, removed: 0, kept: 3 });
  assert.deepEqual(gone(again, await everything()), {});
});

test('the window is never shorter than a session, and a dry run takes nothing', async () => {
  const recent = await profile({ guest: true, days: 3 });
  const was = await everything();
  const dry = await sweepGuests({ db, days: 1, dryRun: true });
  assert.equal(dry.removed, 0);
  await sweepGuests({ db, days: 1 }); // a 1-day setting still waits out the 7-day session
  assert.deepEqual(gone(was, await everything()), {});
  assert.ok(await one(`SELECT 1 FROM ${USERS} WHERE id = $1`, [recent.id]));
  await assert.rejects(sweepGuests({ db, days: 0 }), /GUEST_RETENTION_DAYS must be a positive number/);
});

test('a failed run is logged, never thrown', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const r = await runGuestSweep({ db: { connect: async () => { throw new Error('database down'); } } });
  assert.deepEqual(r, { failed: 'database down' });
  assert.match(String(logged.mock.calls[0].arguments.join(' ')), /Guest sweep failed .*database down/);
});


// What the Waypoint tests need of this app's schema.
const sweep = (extra) => sweepGuests({ db, days: 30, ...extra });
const USERS_T = 'profiles';
const ID_COL = 'id';
const muteErrors = (t) => {
  const m = t.mock.method(console, 'error', () => {});
  return () => m.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
};
/** An idle guest (40 days) that made a circle of its own. */
async function idleWithOwn() {
  const guest = await profile({ guest: true, days: 40 });
  const own = await circle(guest);
  return { guest, uid: guest.id, central: guest.central_user_id, own };
}
const ownGone = async (c) => !(await one('SELECT 1 FROM circles WHERE id = $1', [c.id]));
const guestGone = async (id) => !(await one('SELECT 1 FROM profiles WHERE id = $1', [id]));
/** A guest here is told by its name, so there is no flag to clear: a claimed guest's row is untouched. */
const accountsKept = async () => {};

// Waypoint's word decides who may go (guestCheck.js): the stand-in answers per central id.

/** Takes whatever idle guests earlier tests left, with the stand-in at its default. */
async function clearTheDecks() {
  waypoint.reset();
  await sweep();
  waypoint.reset();
}

test('a guest who claimed on Waypoint stays; one Waypoint has forgotten goes', async () => {
  await clearTheDecks();
  const claimed = await idleWithOwn();
  const forgotten = await idleWithOwn();
  const plain = await idleWithOwn();
  waypoint.set({ claimed: [claimed.central], gone: [forgotten.central] });
  const was = await everything();
  const r = await sweep();
  const now = await everything();
  await accountsKept(was, now, [claimed]);
  const went = gone(was, now);
  assert.deepEqual(ids(went[USERS_T], ID_COL), sorted([forgotten.uid, plain.uid]));
  assert.equal(await ownGone(claimed.own), false, 'a claimed account keeps what it made');
  assert.equal(await ownGone(forgotten.own), true);
  assert.equal(await ownGone(plain.own), true);
  assert.equal(r.claimed, 1);
  assert.equal(r.removed, 2);
  assert.equal(waypoint.requests.length, 1);
  for (const x of [claimed, forgotten, plain]) assert.ok(waypoint.requests[0].ids.includes(Number(x.central)), 'every idle guest was asked about');
});

test('a guest Waypoint does not link to this app stays, with what it made, and is logged', async (t) => {
  await clearTheDecks();
  const logged = muteErrors(t);
  const stranger = await idleWithOwn();
  const plain = await idleWithOwn();
  waypoint.set({ unknown: [stranger.central] });
  const was = await everything();
  const r = await sweep();
  assert.deepEqual(ids(gone(was, await everything())[USERS_T], ID_COL), [plain.uid]);
  assert.equal(await ownGone(stranger.own), false);
  assert.equal(r.unknown, 1);
  assert.match(logged(), new RegExp(`does not link them to this app: ${stranger.central}`));
});

test('a guest nobody asked about is never taken: only cleared guests count as idle', async () => {
  await clearTheDecks();
  const asked = await idleWithOwn();
  const late = await idleWithOwn();
  // Waypoint is asked about `asked` only, as if `late` had become idle after the question
  const check = (list) => checkGuests(list.filter((c) => String(c) !== String(late.central)));
  const was = await everything();
  await sweep({ check });
  assert.deepEqual(ids(gone(was, await everything())[USERS_T], ID_COL), [asked.uid]);
  assert.equal(await ownGone(late.own), false);
});

for (const [what, set] of [
  ['an error', (w) => { w.status = 500; }],
  ['a wrong secret', (w) => { w.status = 401; }],
  ['an endpoint that is not deployed yet (404)', (w) => { w.status = 404; }],
]) {
  test(`${what} from Waypoint means nobody is deleted, whoever is idle`, async (t) => {
    await clearTheDecks();
    const logged = muteErrors(t);
    const a = await idleWithOwn();
    const b = await idleWithOwn();
    set(waypoint);
    const was = await everything();
    const r = await runGuestSweep({ db, days: 30 });
    assert.deepEqual(gone(was, await everything()), {});
    assert.equal(r.removed, 0);
    assert.ok(r.held && r.stale >= 2);
    assert.match(logged(), /Guest sweep paused, nobody removed/);
    // the next day Waypoint answers, and they go
    waypoint.reset();
    const next = await runGuestSweep({ db, days: 30 });
    assert.ok(next.removed >= 2);
    assert.equal(await guestGone(a.uid), true);
    assert.equal(await guestGone(b.uid), true);
  });
}

test('no answer in time, an unreachable Waypoint and no configuration mean nobody is deleted', async () => {
  await clearTheDecks();
  await idleWithOwn();
  const was = await everything();
  waypoint.delay = 300;
  const slow = await sweep({ check: (list) => checkGuests(list, { timeoutMs: 40 }) });
  assert.match(slow.held, /did not answer/);
  const off = await sweep({ check: (list) => checkGuests(list, { env: {} }) });
  assert.match(off.held, /not configured/);
  const dead = await startWaypoint();
  const env = dead.env();
  await dead.close();
  const down = await sweep({ check: (list) => checkGuests(list, { env }) });
  assert.match(down.held, /could not be reached/);
  assert.deepEqual(gone(was, await everything()), {});
});

test('a dry run asks but changes nothing, even for a claimed guest', async () => {
  await clearTheDecks();
  const claimed = await idleWithOwn();
  waypoint.set({ claimed: [claimed.central] });
  const was = await everything();
  const r = await sweep({ dryRun: true });
  assert.equal(r.removed, 0);
  assert.equal(r.claimed, 1);
  assert.deepEqual(gone(was, await everything()), {});
});

test('the clearing table does not outlive a run', async () => {
  await clearTheDecks();
  await idleWithOwn();
  await sweep();
  assert.equal((await one(`SELECT to_regclass('guest_clear')::text AS t`)).t, null);
});
