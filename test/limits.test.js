// Limits on what a script could hammer: wrong join-code guesses (10 per 15 minutes, per address
// and per account) and guest sign-ins (5 an hour per address). Clients are told apart by the
// last X-Forwarded-For entry, which is what Railway's edge appends; whatever a client writes
// before that entry must not matter.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

const JOIN_MAX_WRONG = 10;
const GUESTS_PER_HOUR = 5;

let app;
before(async () => { app = await startApp(); });
after(async () => { await app?.stop(); });

// Sent from `address` as Railway forwards it, with `spoof` written in by the client first.
const from = (address, spoof) => ({ 'X-Forwarded-For': spoof ? `${spoof}, ${address}` : address });

async function newCircle() {
  const owner = await app.guest();
  const res = await owner.as('POST', '/api/circles', { name: 'Family' });
  assert.equal(res.status, 200);
  return { owner, circle: res.body.circle };
}

async function memberCount(owner, circle) {
  return (await owner.as('GET', `/api/circles/${circle.id}`)).body.members.length;
}

describe('join codes', () => {
  it(`after ${JOIN_MAX_WRONG} wrong codes from one address, it gets 429 even with the right code`, async () => {
    const { owner, circle } = await newCircle();
    const guesser = await app.guest();
    for (let i = 0; i < JOIN_MAX_WRONG; i++) {
      const res = await guesser.as('POST', '/api/circles/join', { join_code: `ZZZZ${i}` }, from('203.0.113.10', `10.0.0.${i}`));
      assert.equal(res.status, 404, `guess ${i}`);
    }
    const res = await guesser.as('POST', '/api/circles/join', { join_code: circle.join_code }, from('203.0.113.10', '10.0.0.99'));
    assert.equal(res.status, 429);
    assert.match(res.body.error, /Too many wrong codes/);

    // Another account on that address is held back too.
    const housemate = await app.guest();
    const second = await housemate.as('POST', '/api/circles/join', { join_code: circle.join_code }, from('203.0.113.10'));
    assert.equal(second.status, 429);
    assert.equal(await memberCount(owner, circle), 1);
  });

  it(`after ${JOIN_MAX_WRONG} wrong codes from one account, it gets 429 from any address`, async () => {
    const { owner, circle } = await newCircle();
    const guesser = await app.guest();
    for (let i = 0; i < JOIN_MAX_WRONG; i++) {
      const res = await guesser.as('POST', '/api/circles/join', { join_code: `YYYY${i}` }, from(`203.0.113.${100 + i}`));
      assert.equal(res.status, 404, `guess ${i}`);
    }
    const res = await guesser.as('POST', '/api/circles/join', { join_code: circle.join_code }, from('203.0.113.200'));
    assert.equal(res.status, 429);

    // Those addresses each made one wrong guess, so someone else there still gets in.
    const friend = await app.guest();
    const joined = await friend.as('POST', '/api/circles/join', { join_code: circle.join_code }, from('203.0.113.100'));
    assert.equal(joined.status, 200);
    assert.equal(await memberCount(owner, circle), 2);
  });

  it('right codes are not counted', async () => {
    const { circle } = await newCircle();
    const member = await app.guest();
    for (let i = 0; i < JOIN_MAX_WRONG + 2; i++) {
      assert.equal((await member.as('POST', '/api/circles/join', { join_code: circle.join_code })).status, 200);
    }
  });
});

describe('guest sign-in', () => {
  it(`allows ${GUESTS_PER_HOUR} an hour from one address, whatever it adds to X-Forwarded-For`, async () => {
    const before = (await app.db.query('SELECT COUNT(*)::int AS n FROM profiles')).rows[0].n;
    for (let i = 0; i < GUESTS_PER_HOUR; i++) {
      const res = await app.request('POST', '/api/auth/guest', { headers: from('203.0.113.50', `10.2.0.${i}`) });
      assert.equal(res.status, 200, `guest ${i}: ${JSON.stringify(res.body)}`);
    }
    const res = await app.request('POST', '/api/auth/guest', { headers: from('203.0.113.50', '10.2.0.99') });
    assert.equal(res.status, 429);
    assert.match(res.body.error, /Too many guest sign-ins/);
    const after = (await app.db.query('SELECT COUNT(*)::int AS n FROM profiles')).rows[0].n;
    assert.equal(after - before, GUESTS_PER_HOUR);

    // Another address is unaffected.
    assert.equal((await app.request('POST', '/api/auth/guest', { headers: from('198.51.100.50') })).status, 200);
  });
});
