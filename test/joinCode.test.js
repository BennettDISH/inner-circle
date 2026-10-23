// Join codes (services/circles.js): how they are drawn, and what happens when one is already
// taken. A clash can't be made to happen through the running app (36^6 codes), so this drives
// insertCircle straight against the real schema in an in-memory Postgres, with a code source
// that returns what the test says.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

let dbServer, db, generateJoinCode, insertCircle;

before(async () => {
  const pglite = await PGlite.create();
  dbServer = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1', maxConnections: 4 });
  await dbServer.start();
  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${dbServer.port}/postgres`;
  const { initDb, default: pool } = await import('../config/db.js');
  await initDb();
  db = pool;
  await db.query(`INSERT INTO profiles (central_user_id, username) VALUES (1, 'maker')`);
  ({ generateJoinCode, insertCircle } = await import('../services/circles.js'));
});

after(async () => {
  await db?.end().catch(() => {});
  await dbServer?.stop().catch(() => {});
});

/** A code source that hands out `codes` in order, and fails the test if asked for more. */
const codes = (...list) => {
  const queue = [...list];
  return () => {
    assert.ok(queue.length, 'asked for more codes than the test gave');
    return queue.shift();
  };
};
const circle = (name) => ({ name, description: '', createdBy: 1 });
/** Run `fn(client)` in a transaction, as the route does: commit when it returns, roll back when it throws. */
async function transaction(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
const codesInUse = async () => (await db.query('SELECT join_code FROM circles ORDER BY id')).rows.map((r) => r.join_code);

test('a join code is six characters of 0-9 and A-Z, drawn from crypto.randomInt', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const code = generateJoinCode();
    assert.match(code, /^[0-9A-Z]{6}$/);
    seen.add(code);
  }
  assert.ok(seen.size > 45, 'codes repeat far too often');

  // Every draw is a number below 36: the first and last characters of the alphabet at the ends.
  const asked = [];
  assert.equal(generateJoinCode((n) => { asked.push(n); return asked.length % 2 ? 0 : 35; }), '0Z0Z0Z');
  assert.deepEqual(asked, [36, 36, 36, 36, 36, 36]);
});

test('a code that is free is used as it is', async () => {
  const made = await transaction((c) => insertCircle(c, circle('First'), codes('AAAAAA')));
  assert.equal(made.join_code, 'AAAAAA');
  assert.equal(made.name, 'First');
});

test('a clash gets one more code, and the caller\'s transaction carries on', async () => {
  await transaction(async (client) => {
    const made = await insertCircle(client, circle('Second'), codes('AAAAAA', 'BBBBBB'));
    assert.equal(made.join_code, 'BBBBBB');
    // The failed first insert did not abort the transaction: more work in it still goes through.
    await client.query(`INSERT INTO circle_members (circle_id, central_user_id, role) VALUES ($1, 1, 'admin')`, [made.id]);
  });
  assert.deepEqual(await codesInUse(), ['AAAAAA', 'BBBBBB']);
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM circle_members WHERE circle_id = (SELECT id FROM circles WHERE join_code = 'BBBBBB')`);
  assert.equal(rows[0].n, 1);
});

test('a second clash in a row is an error, and leaves no circle behind', async () => {
  const was = await codesInUse();
  await assert.rejects(
    transaction((c) => insertCircle(c, circle('Third'), codes('AAAAAA', 'BBBBBB'))),
    (err) => err.code === '23505',
  );
  assert.deepEqual(await codesInUse(), was);
});

test('only a join-code clash is retried', async () => {
  const was = await codesInUse();
  let draws = 0;
  await assert.rejects(
    transaction((c) => insertCircle(c, { name: 'Nobody made this', description: '', createdBy: 999 }, () => `NEW${++draws}00`)),
    (err) => err.code === '23503', // no such profile: a foreign key error, not a clash
  );
  assert.equal(draws, 1);
  assert.deepEqual(await codesInUse(), was);
});
