// The guest sweep takes the photo objects of the circles it deletes, and only those: straight
// against PGlite, with a fake S3 client standing in for R2 in this process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

let dbServer, db, sweepGuests, useClientForTests;
const bucket = new Map(); // key -> bytes: what the fake R2 holds
let failDelete = false;
// Waypoint's word is not what these tests are about (guestSweep.test.js has it): every idle guest may go
const everyoneMayGo = async (ids) => ({ ok: true, clear: ids.map(String), claimed: [], unknown: [] });

before(async () => {
  const pglite = await PGlite.create();
  const port = 20000 + Math.floor(Math.random() * 20000);
  dbServer = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1', maxConnections: 8 });
  await dbServer.start();
  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const { initDb, default: pool } = await import('../config/db.js');
  await initDb();
  db = pool;
  ({ sweepGuests } = await import('../services/guestSweep.js'));
  ({ useClientForTests } = await import('../config/r2.js'));
  useClientForTests({
    async send(command) {
      const { Key, Body } = command.input;
      switch (command.constructor.name) {
        case 'PutObjectCommand': bucket.set(Key, Body); return {};
        case 'DeleteObjectCommand':
          if (failDelete) throw Object.assign(new Error('fake R2 is down'), { name: 'ServiceUnavailable' });
          bucket.delete(Key);
          return {};
        default: throw new Error(`fake R2 does not know ${command.constructor.name}`);
      }
    },
  });
});

after(async () => {
  useClientForTests?.(null);
  await db?.end().catch(() => {});
  await dbServer?.stop().catch(() => {});
});

const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

let n = 0;
const profile = ({ guest = false, days = 0 } = {}) => {
  n += 1;
  return one(
    `INSERT INTO profiles (central_user_id, username, created_at, updated_at)
     VALUES ($1, $2, NOW() - ($3 || ' days')::interval, NOW() - ($3 || ' days')::interval) RETURNING *`,
    [900 + n, guest ? `guest-swift-otter-${2000 + n}` : `player${n}`, String(days)]);
};
const circleWithPhotos = async (maker, photos) => {
  const c = await one(`INSERT INTO circles (name, join_code, created_by) VALUES ('Circle', $1, $2) RETURNING *`, [`P${n}x${Math.random()}`.slice(0, 20), maker.central_user_id]);
  await q(`INSERT INTO circle_members (circle_id, central_user_id, role) VALUES ($1, $2, 'admin')`, [c.id, maker.central_user_id]);
  const l = await one(`INSERT INTO listings (circle_id, central_user_id, title) VALUES ($1, $2, 'A ladder') RETURNING *`, [c.id, maker.central_user_id]);
  const keys = [];
  for (let i = 0; i < photos; i++) {
    const key = `circles/${c.id}/${'a'.repeat(23)}${i}.webp`;
    await q(`INSERT INTO listing_photos (listing_id, object_key, content_type, bytes, position) VALUES ($1, $2, 'image/webp', 3, $3)`, [l.id, key, i]);
    bucket.set(key, Buffer.from('abc'));
    keys.push(key);
  }
  return { circle: c, keys };
};

test('an idle guest\'s circle goes with its photo objects; a circle that stays keeps its photos', async () => {
  const idle = await profile({ guest: true, days: 40 });
  const gone = await circleWithPhotos(idle, 3);
  const real = await profile({ days: 400 });
  const kept = await circleWithPhotos(real, 2);
  // an idle guest's circle that a real account joined stays, so its photos do too
  const hosted = await profile({ guest: true, days: 40 });
  const shared = await circleWithPhotos(hosted, 2);
  await q(`INSERT INTO circle_members (circle_id, central_user_id) VALUES ($1, $2)`, [shared.circle.id, real.central_user_id]);

  const r = await sweepGuests({ db, days: 30, check: everyoneMayGo });
  assert.equal(r.made, 1);
  assert.equal((await q('SELECT 1 FROM circles WHERE id = $1', [gone.circle.id])).length, 0);
  assert.equal((await q('SELECT 1 FROM listing_photos WHERE object_key = ANY($1)', [gone.keys])).length, 0);
  for (const key of gone.keys) assert.ok(!bucket.has(key), `${key} left the bucket`);
  for (const key of [...kept.keys, ...shared.keys]) assert.ok(bucket.has(key), `${key} stays`);
  assert.equal((await q('SELECT 1 FROM listing_photos WHERE object_key = ANY($1)', [[...kept.keys, ...shared.keys]])).length, 4);
});

test('a bucket that will not delete does not stop the sweep', async () => {
  const idle = await profile({ guest: true, days: 41 });
  const gone = await circleWithPhotos(idle, 1);
  failDelete = true;
  const r = await sweepGuests({ db, days: 30, check: everyoneMayGo });
  failDelete = false;
  assert.equal(r.made, 1);
  assert.equal((await q('SELECT 1 FROM circles WHERE id = $1', [gone.circle.id])).length, 0);
});
