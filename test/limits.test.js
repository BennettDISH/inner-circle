// Limits on what a script could hammer: wrong join-code guesses (10 per 15 minutes, per address
// and per account), guest sign-ins (5 an hour per address) and Waypoint sign-in tries (password
// logins and SSO returns, 10 per 15 minutes per address). Clients are told apart by the last
// X-Forwarded-For entry, which is what Railway's edge appends; whatever a client writes before
// that entry must not matter.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

const JOIN_MAX_WRONG = 10;
const GUESTS_PER_HOUR = 5;
const SIGN_IN_TRIES = 10;

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

describe('Waypoint sign-in tries', () => {
  // Waypoint counts password logins and code exchanges in one bucket of 30 per 15 minutes for
  // this whole server, so one address may use only a third of it.
  const credentials = { email: 'tries@example.test', password: 'right-password' };
  let account;
  before(async () => {
    const res = await app.request('POST', '/api/auth/register', { body: { ...credentials, username: 'tries' } });
    assert.equal(res.status, 200);
    account = res.body.user;
  });

  const login = (address, spoof, password = 'wrong-password') =>
    app.request('POST', '/api/auth/login', { body: { ...credentials, password }, headers: from(address, spoof) });
  // A code Waypoint would accept: the SSO return for the account above.
  const callback = (address, code = app.waypoint.issueCode(account)) =>
    app.request('POST', '/api/auth/sso-callback', { body: { code }, headers: from(address) });

  it(`allows ${SIGN_IN_TRIES} password tries from one address, then 429 even for the right password`, async () => {
    for (let i = 0; i < SIGN_IN_TRIES; i++) {
      const res = await login('203.0.113.60', `10.3.0.${i}`);
      assert.equal(res.status, 400, `try ${i}`);
      assert.equal(res.body.error, 'Invalid email or password');
    }
    const blocked = await login('203.0.113.60', '10.3.0.99', credentials.password);
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /Too many sign-in attempts/);
    assert.equal(blocked.body.token, undefined);

    // Another address, with or without the same spoofed entry, is untouched.
    assert.equal((await login('203.0.113.61', '10.3.0.99', credentials.password)).status, 200);
  });

  it('right passwords count too: each one uses a Waypoint try', async () => {
    for (let i = 0; i < SIGN_IN_TRIES; i++) {
      assert.equal((await login('203.0.113.62', undefined, credentials.password)).status, 200, `try ${i}`);
    }
    assert.equal((await login('203.0.113.62', undefined, credentials.password)).status, 429);
  });

  it('password logins and SSO returns from one address share the same ten', async () => {
    for (let i = 0; i < SIGN_IN_TRIES / 2; i++) assert.equal((await login('203.0.113.63')).status, 400);
    for (let i = 0; i < SIGN_IN_TRIES / 2; i++) assert.equal((await callback('203.0.113.63')).status, 200, `return ${i}`);

    assert.equal((await login('203.0.113.63', undefined, credentials.password)).status, 429);
    // A refused SSO return never reaches Waypoint, so its code is not used up.
    const code = app.waypoint.issueCode(account);
    const refused = await callback('203.0.113.63', code);
    assert.equal(refused.status, 429);
    assert.match(refused.body.error, /Too many sign-in attempts/);
    assert.equal((await callback('203.0.113.64', code)).status, 200);
  });

  it('is its own count: guest sign-ins and join codes from the same address are not affected, nor it by them', async () => {
    // Used up for 203.0.113.65, it still lets that address start a guest and guess join codes.
    for (let i = 0; i < SIGN_IN_TRIES; i++) await login('203.0.113.65');
    assert.equal((await login('203.0.113.65')).status, 429);
    const guest = await app.guest('203.0.113.65');
    const wrong = await guest.as('POST', '/api/circles/join', { join_code: 'NOSUCH' });
    assert.equal(wrong.status, 404);

    // And the other way round: guest sign-ins and wrong codes used up at 203.0.113.66 leave
    // password logins there alone.
    for (let i = 0; i < GUESTS_PER_HOUR; i++) await app.guest('203.0.113.66');
    assert.equal((await app.request('POST', '/api/auth/guest', { headers: from('203.0.113.66') })).status, 429);
    const guesser = await app.guest('203.0.113.67');
    for (let i = 0; i < JOIN_MAX_WRONG; i++) await guesser.as('POST', '/api/circles/join', { join_code: `XXXX${i}` });
    assert.equal((await guesser.as('POST', '/api/circles/join', { join_code: 'XXXXXX' })).status, 429);
    assert.equal((await login('203.0.113.66')).status, 400);
    assert.equal((await login('203.0.113.67', undefined, credentials.password)).status, 200);
  });
});
