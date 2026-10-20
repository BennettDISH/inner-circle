// Test kit: an in-memory Postgres (PGlite, the real engine compiled to WASM) served on the
// wire protocol, a stand-in Waypoint (auth-service), and the real server.js run as a child
// process. The tests drive the same routes and `pg` Pool that run in production.
import http from 'node:http';
import net from 'node:net';
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
// guest (a new central account per call, ids from 1000 up), register, login, and the OAuth
// code exchange. issueCode() stands in for a user approving the app on Waypoint.
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
      case '/api/auth/proxy/guest': {
        const id = nextId++;
        return send(200, { central_user_id: id, username: `guest${id}`, email: null, first_name: `Guest${id}`, last_name: '', is_guest: true });
      }
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
    stop: () => new Promise((r) => server.close(r)),
  };
}

/** Start Postgres, the stand-in Waypoint and the app. Returns helpers and stop().
 *  `adminIds` is ADMIN_CENTRAL_USER_IDS (Waypoint ids start at 1000). */
export async function startApp({ adminIds = '' } = {}) {
  const db = await startPostgres();
  const waypoint = await startWaypoint();
  const port = await freePort();
  // Every variable the server reads is pinned here. dotenv never overrides a variable that is
  // already set, so a local .env can't leak into a test run.
  const child = spawn(process.execPath, ['server.js'], {
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

  /** Send a request. `raw` sends a string body as-is (for malformed JSON). */
  const request = async (method, url, { token, body, raw } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, {
      method,
      headers,
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, body: data };
  };

  const signedIn = ({ token, user }) => ({ token, user, as: (method, url, body) => request(method, url, { token, body }) });

  return {
    base,
    db,
    waypoint,
    request,
    alive,
    log: () => log,
    /** Sign in through the real guest flow; returns { token, user, as } where `as` is a
     *  request function bound to this user's token. */
    async guest() {
      const res = await request('POST', '/api/auth/guest');
      if (res.status !== 200) throw new Error(`guest sign-in failed: ${res.status} ${JSON.stringify(res.body)}`);
      return signedIn(res.body);
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
    },
  };
}
