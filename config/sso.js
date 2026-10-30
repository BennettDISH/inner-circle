export const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL;
export const SSO_CLIENT_ID = process.env.SSO_CLIENT_ID;
export const SSO_ENABLED = Boolean(
  AUTH_SERVICE_URL && SSO_CLIENT_ID && process.env.SSO_CLIENT_SECRET
);

// Every call to Waypoint gives up after 10 s instead of holding the sign-in open.
const TIMEOUT_MS = 10_000;

// Errors raised here are for the visitor to read (Waypoint's own "Invalid email or password",
// or that it did not answer), so they carry `expose` and the status the route answers with.
// The routes send anything else (the profile write, say) to the 500 handler.
function waypointError(message, status = 400) {
  return Object.assign(new Error(message), { status, expose: true });
}

async function post(path, body, failed, { timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body,
        client_id: process.env.SSO_CLIENT_ID,
        client_secret: process.env.SSO_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw waypointError(err.error || failed);
    }
    return await res.json();
  } catch (err) {
    if (err?.name === 'TimeoutError') throw waypointError('Waypoint did not answer. Try again in a moment.', 504);
    throw err;
  }
}

// `options.timeoutMs` is for the tests; the routes always wait the full TIMEOUT_MS.
export function centralRegister({ username, email, password, first_name, last_name }, options) {
  return post('/api/auth/proxy/register', { username, email, password, first_name, last_name }, 'Registration failed', options);
}

export function centralLogin({ email, password }, options) {
  return post('/api/auth/proxy/login', { email, password }, 'Login failed', options);
}

export function exchangeCode(code, options) {
  return post('/oauth/token', { grant_type: 'authorization_code', code }, 'Code exchange failed', options);
}
