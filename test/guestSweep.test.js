// The guest sweep (services/guestSweep.js) against the real schema, in an in-memory Postgres.
// What it may take is exactly an idle guest and what only guests had a part in: every other
// row in every table is compared, before and after, and must be there unchanged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

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
