// Guests are refused. Waypoint's own sign-in page offers "Continue as guest" whatever an app
// wants, so the app answers 403 at the SSO callback (and at register and login, should Waypoint
// ever return a guest there) before a profile row or a token is made, and has no guest route.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let app;
const ADMIN_ID = 1000; // the stand-in Waypoint's first account, which the first test makes a guest
before(async () => { app = await startApp({ adminIds: String(ADMIN_ID) }); });
after(async () => { await app?.stop(); });

const profileCount = async () => (await app.db.query('SELECT COUNT(*)::int AS n FROM profiles')).rows[0].n;
const GUEST_MESSAGE = 'Guest accounts can’t be used here. Sign in with your own account.';

describe('guests are refused', () => {
  it('at the SSO callback: 403 with the reason, no token, no profile, even for an id on the admin list', async () => {
    const before = await profileCount();
    const { code, account } = app.waypoint.issueGuestCode();
    assert.equal(account.central_user_id, ADMIN_ID);
    const res = await app.request('POST', '/api/auth/sso-callback', { body: { code } });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: GUEST_MESSAGE });
    assert.equal(await profileCount(), before);

    const again = app.waypoint.issueGuestCode();
    const second = await app.request('POST', '/api/auth/sso-callback', { body: { code: again.code } });
    assert.equal(second.status, 403);
    assert.equal(second.body.token, undefined);
    assert.equal(await profileCount(), before);
  });

  it('a real account still signs in through the callback', async () => {
    const account = { central_user_id: 5000, username: 'sam', email: 'sam@example.test', first_name: 'Sam', last_name: 'Ng' };
    const res = await app.request('POST', '/api/auth/sso-callback', { body: { code: app.waypoint.issueCode(account) } });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.user.central_user_id, 5000);
  });

  it('at register and login, if Waypoint returns a guest there', async () => {
    const before = await profileCount();
    const body = { username: 'guest-quiet-fox-1234', email: 'fox@example.test', password: 'pw' };
    const reg = await app.request('POST', '/api/auth/register', { body });
    assert.equal(reg.status, 403);
    assert.equal(reg.body.token, undefined);
    const login = await app.request('POST', '/api/auth/login', { body: { email: body.email, password: body.password } });
    assert.equal(login.status, 403);
    assert.equal(login.body.token, undefined);
    assert.equal(await profileCount(), before);
  });

  it('there is no guest route any more', async () => {
    for (const method of ['POST', 'GET']) {
      const res = await app.request(method, '/api/auth/guest');
      assert.equal(res.status, 404, method);
      assert.equal(res.body.token, undefined);
    }
  });
});
