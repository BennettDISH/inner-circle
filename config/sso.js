const AUTH_URL = process.env.AUTH_SERVICE_URL;

export async function centralRegister({ username, email, password, first_name, last_name }) {
  const res = await fetch(`${AUTH_URL}/api/auth/proxy/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username, email, password, first_name, last_name,
      client_id: process.env.SSO_CLIENT_ID,
      client_secret: process.env.SSO_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Registration failed');
  }
  return res.json();
}

export async function centralLogin({ email, password }) {
  const res = await fetch(`${AUTH_URL}/api/auth/proxy/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password,
      client_id: process.env.SSO_CLIENT_ID,
      client_secret: process.env.SSO_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Login failed');
  }
  return res.json();
}

export async function exchangeCode(code) {
  const res = await fetch(`${AUTH_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.SSO_CLIENT_ID,
      client_secret: process.env.SSO_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Code exchange failed');
  }
  return res.json();
}
