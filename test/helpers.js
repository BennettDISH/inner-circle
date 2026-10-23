// Test kit: an in-memory Postgres (PGlite, the real engine compiled to WASM) served on the
// wire protocol, a stand-in Waypoint (auth-service), and the real server.js run as a child
// process. The tests drive the same routes and `pg` Pool that run in production.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-secret';
export const JWT_SECRET = 'test-jwt-secret';
export const APP_BASE_URL = 'http://app.test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// PGlite answers an error in the extended protocol (Parse, Bind, Execute...) with
// ErrorResponse plus an immediate ReadyForQuery, then sends another ReadyForQuery for the Sync.
// Real Postgres only sends the one after Sync. pg takes the extra one as the end of whatever
// it sends next, so the ROLLBACK after a failed insert in POST /api/circles gets out of step
// and the server dies on "unexpected commandComplete". Drop ReadyForQuery from the replies to
// those messages so the wire matches Postgres.
const EXTENDED = new Set(['P', 'B', 'D', 'E', 'C', 'H'].map((c) => c.charCodeAt(0)));
const READY_FOR_QUERY = 'Z'.charCodeAt(0);

function withoutReadyForQuery(buf) {
  const keep = [];
  for (let i = 0; i + 5 <= buf.length;) {
    const end = i + 1 + buf.readInt32BE(i + 1);
    if (buf[i] !== READY_FOR_QUERY) keep.push(buf.subarray(i, end));
    i = end;
  }
  return Buffer.concat(keep);
}

function matchPostgresOnErrors(pglite) {
  const exec = pglite.execProtocolRawStream.bind(pglite);
  pglite.execProtocolRawStream = async (message, options = {}) => {
    if (!EXTENDED.has(message[0])) return exec(message, options);
    const chunks = [];
    const result = await exec(message, { ...options, onRawData: (d) => chunks.push(Buffer.from(d)) });
    const out = withoutReadyForQuery(Buffer.concat(chunks));
    if (out.length) options.onRawData?.(new Uint8Array(out));
    return result;
  };
}

async function startPostgres() {
  const pglite = await PGlite.create();
  matchPostgresOnErrors(pglite);
  const server = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1', maxConnections: 20 });
  await server.start();
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${server.port}/postgres`,
    /** Straight to the database, not through the app. */
    query: (text, params) => pglite.query(text, params),
    async stop() {
      // Closed client connections are detached asynchronously, and a detach that reaches a
      // closed PGlite throws outside any test. Let them drain first.
      for (let i = 0; i < 100 && server.getStats().activeConnections > 0; i++) await sleep(20);
      await server.stop().catch(() => {});
      await sleep(100);
      await pglite.close().catch(() => {});
    },
  };
}

// Answers the auth-service calls in config/sso.js, checking the app's client credentials:
// register (a new central account per call, ids from 1000 up), login, and the OAuth code
// exchange. issueCode() stands in for a user approving the app on Waypoint, and
// issueGuestCode() for someone who picked "Continue as guest" on Waypoint's own sign-in page.
// A register under a `guest-` username comes back flagged is_guest, to prove the app refuses
// that on every route.
async function startWaypoint() {
  let nextId = 1000;
  const accounts = new Map(); // email -> account with password
  const codes = new Map(); // code -> account
  const publicView = ({ password, ...account }) => account;

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}
    const send = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));

    if (req.method !== 'POST') return send(404, { error: 'not found' });
    if (body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) return send(401, { error: 'Invalid client' });

    switch (req.url) {
      case '/api/auth/proxy/register': {
        if (!body.email || !body.password || !body.username) return send(400, { error: 'Username, email and password required' });
        if (accounts.has(body.email)) return send(409, { error: 'Email already registered' });
        const account = {
          central_user_id: nextId++,
          username: body.username,
          email: body.email,
          first_name: body.first_name || '',
          last_name: body.last_name || '',
          password: body.password,
          ...(body.username.startsWith('guest-') && { is_guest: true }),
        };
        accounts.set(body.email, account);
        return send(201, publicView(account));
      }
      case '/api/auth/proxy/login': {
        const account = accounts.get(body.email);
        if (!account || account.password !== body.password) return send(401, { error: 'Invalid email or password' });
        return send(200, publicView(account));
      }
      case '/oauth/token': {
        const account = body.grant_type === 'authorization_code' && codes.get(body.code);
        if (!account) return send(400, { error: 'invalid_grant' });
        codes.delete(body.code);
        return send(200, account);
      }
      default:
        return send(404, { error: 'not found' });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let nextCode = 1;
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    issueCode(account) {
      const code = `code-${nextCode++}`;
      codes.set(code, account);
      return code;
    },
    /** A code for a brand-new Waypoint guest account; returns { code, account }. */
    issueGuestCode() {
      const id = nextId++;
      const account = { central_user_id: id, username: `guest-swift-otter-${id}`, email: null, first_name: '', last_name: '', is_guest: true };
      return { code: this.issueCode(account), account };
    },
    stop: () => new Promise((r) => server.close(r)),
  };
}

export const FAKE_BUCKET = 'inner-circle-test';

/** Start Postgres, the stand-in Waypoint and the app. Returns helpers and stop().
 *  `adminIds` is ADMIN_CENTRAL_USER_IDS (Waypoint ids start at 1000); `distDir` is DIST_DIR, the
 *  folder of built pages (the default is the repo's dist/, which only exists after a build).
 *  `fakeR2: true` gives the app all four R2 variables and a fake S3 client in place of R2
 *  (test/fakeR2.js); `photoBudget` is that app's bytes per account per day. `env` adds or
 *  overrides variables, e.g. to give the app only some of the R2 ones. */
export async function startApp({ adminIds = '', distDir = '', fakeR2 = false, photoBudget, env = {} } = {}) {
  const db = await startPostgres();
  const waypoint = await startWaypoint();
  const port = await freePort();
  const r2Dir = fakeR2 ? fs.mkdtempSync(path.join(os.tmpdir(), 'inner-circle-r2-')) : null;
  // Every variable the server reads is pinned here. dotenv never overrides a variable that is
  // already set, so a local .env can't leak into a test run.
  const child = spawn(process.execPath, [...(fakeR2 ? ['--import', './test/fakeR2.js'] : []), 'server.js'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      NODE_ENV: 'test',
      DATABASE_URL: db.url,
      JWT_SECRET,
      AUTH_SERVICE_URL: waypoint.url,
      SSO_CLIENT_ID: CLIENT_ID,
      SSO_CLIENT_SECRET: CLIENT_SECRET,
      APP_BASE_URL,
      ADMIN_CENTRAL_USER_IDS: adminIds,
      DIST_DIR: distDir,
      ...(fakeR2 && {
        R2_ACCOUNT_ID: 'test-account',
        R2_ACCESS_KEY_ID: 'test-key',
        R2_SECRET_ACCESS_KEY: 'test-secret-key',
        R2_BUCKET: FAKE_BUCKET,
        FAKE_R2_DIR: r2Dir,
        ...(photoBudget && { FAKE_R2_BUDGET: String(photoBudget) }),
      }),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const alive = () => child.exitCode === null && child.signalCode === null;

  // The server only listens once initDb() has built the schema.
  const deadline = Date.now() + 30000;
  for (;;) {
    if (!alive()) throw new Error(`server exited early:\n${log}`);
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`server did not start:\n${log}`);
    await sleep(100);
  }

  // Each client sends its requests from its own address, in X-Forwarded-For the way Railway's
  // edge forwards it, so the per-address limits (10 Waypoint sign-in tries per 15 minutes, 10
  // wrong join codes) don't run out across a test file. A user keeps one address for their
  // life; a request with no headers of its own comes from a fresh one.
  let nextClient = 1;
  let nextUser = 1;
  const clientAddress = () => {
    const n = nextClient++;
    return `198.18.${n >> 8}.${n & 255}`;
  };
  const from = (address) => ({ 'X-Forwarded-For': address });

  /** Send a request. `raw` sends a string body as-is (for malformed JSON). `headers` replace
   *  the default fresh client address. `image` sends those bytes as they are, with `type` as the
   *  Content-Type (a photo); `binary` answers the body as a Buffer instead of text or JSON. */
  const request = async (method, url, { token, body, raw, image, type, binary, headers: extraHeaders = from(clientAddress()) } = {}) => {
    const headers = { ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
    if (image !== undefined) headers['Content-Type'] = type;
    const res = await fetch(base + url, {
      method,
      headers,
      body: image !== undefined ? image : raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    if (binary) return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, body: data, headers: res.headers };
  };

  /** What the fake R2 holds: [{ key, bucket, contentType, cacheControl, body: Buffer }], and a
   *  switch to make its puts, gets or deletes fail. */
  const r2 = {
    objects: () => fs.readdirSync(r2Dir).filter((f) => f.startsWith('obj-')).map((f) => {
      const o = JSON.parse(fs.readFileSync(path.join(r2Dir, f), 'utf8'));
      return { ...o, body: Buffer.from(o.body, 'base64') };
    }),
    keys() { return this.objects().map((o) => o.key).sort(); },
    /** Take an object out behind the app's back. */
    remove(key) { fs.rmSync(path.join(r2Dir, `obj-${encodeURIComponent(key)}.json`), { force: true }); },
    fail(what, on = true) {
      const f = path.join(r2Dir, `FAIL_${what.toUpperCase()}`);
      if (on) fs.writeFileSync(f, ''); else fs.rmSync(f, { force: true });
    },
  };

  const signedIn = ({ token, user }, address) => ({
    token,
    user,
    address,
    as: (method, url, body, headers = from(address)) => request(method, url, { token, body, headers }),
    /** POST a photo (the bytes of an image) to a listing. */
    photo: (listingId, bytes, type = 'image/webp') => request('POST', `/api/listings/${listingId}/photos`, { token, image: bytes, type, headers: from(address) }),
    /** Read a photo's bytes. */
    getPhoto: (listingId, photoId) => request('GET', `/api/listings/${listingId}/photos/${photoId}`, { token, binary: true, headers: from(address) }),
  });

  return {
    base,
    db,
    waypoint,
    request,
    r2,
    alive,
    log: () => log,
    /** Register a new account through the real register route (Waypoint's stand-in makes the
     *  central account) from `address` (a fresh one by default); returns { token, user, address,
     *  as } where `as` is a request function bound to this user's token and address (a fourth
     *  argument replaces the headers). */
    async user(address = clientAddress()) {
      const n = nextUser++;
      const res = await request('POST', '/api/auth/register', {
        headers: from(address),
        body: { username: `user${n}`, email: `user${n}@example.test`, password: `pw-${n}`, first_name: `User${n}`, last_name: 'Test' },
      });
      if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(res.body)}`);
      return signedIn(res.body, address);
    },
    async stop() {
      if (alive()) {
        child.kill();
        await new Promise((r) => child.once('exit', r));
      } else {
        console.error(`server exited during the tests:\n${log}`);
      }
      await waypoint.stop();
      await db.stop();
      if (r2Dir) fs.rmSync(r2Dir, { recursive: true, force: true });
    },
  };
}
