# inner-circle

A trusted network for friends and family to share what they **have** and **need**. Create
circles, post listings, and manage incoming requests.

Live: https://inner-circle-production-a7f8.up.railway.app

## Stack
React 19 + Vite · Express 4 · Postgres · SSO via `auth-service` (Waypoint)

## Getting started
```bash
npm install
cp .env.example .env      # DATABASE_URL, JWT_SECRET, AUTH_SERVICE_URL, SSO_CLIENT_ID/SECRET

npm run server            # Express API on PORT 3000 (node --watch server.js)
npm run dev               # Vite dev server; proxies /api to localhost:3000
```

SSO is configured entirely server-side. The client never sees the `client_id` or the
auth-service URL: the "Sign in with Waypoint" button hits `GET /api/auth/sso/login`,
which builds the `/oauth/authorize` redirect from `AUTH_SERVICE_URL` + `SSO_CLIENT_ID`.
Only `AUTH_SERVICE_URL`, `SSO_CLIENT_ID`, and `SSO_CLIENT_SECRET` are needed (no `VITE_*`).
Every sign-in goes through the auth service; there are no local passwords.

Production: `npm run build` then `npm start`.

## Test and build
`npm test` runs the API tests in `test/`: the real `server.js` against an in-memory Postgres
(PGlite) and a stand-in Waypoint, so no database or secrets are needed. `npm run build`
checks the front end compiles.

## Deploy
Railway service `inner-circle` (production environment) auto-deploys on push to `master`.
The build and deploy settings live on the Railway service itself (there is no `railway.toml`):
Nixpacks builds with `npm install --include=dev && npm run build` (vite is a devDependency)
and starts `node server.js`, restarting on failure up to 10 times. The schema is created on
boot by `initDb()`.

`GET /health` is the healthcheck: it runs one `SELECT 1` (3 second limit) and answers
`200 {"status":"ok","db":"ok"}`, or `503 {"status":"unavailable","db":"not answering"}` with no
database text when the database errors or stays silent. It is never cached.

## Environment variables
Names only; `.env.example` has comments.

- `DATABASE_URL`: Postgres (required; the server exits if the schema can't be applied)
- `JWT_SECRET`: signs the app's own 7-day session tokens
- `AUTH_SERVICE_URL`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`: Waypoint
- `APP_BASE_URL` (optional): public base for the SSO `redirect_uri`
- `ADMIN_CENTRAL_USER_IDS` (optional): comma-separated Waypoint ids who can open the look-only `/admin` page; unset means nobody can
- `GUEST_RETENTION_DAYS` (optional, 30): guests not signed in for this many days are removed daily
- `GUEST_CLEANUP_ENABLED` (optional): `false` turns the guest sweep off
- `PORT`, `NODE_ENV`

## Layout
- `server.js`: Express app, `/health`, the five routers (other `/api` paths are a JSON 404), SPA fallback to `dist/`.
- `routes/health.js`: the `/health` handler (a `SELECT 1` with a 3 second limit; 200, or 503 without database text).
- `config/db.js`: pool and schema (`profiles`, `circles`, `circle_members`, `listings`, `requests`).
- `config/sso.js`: server-to-server calls to the auth service.
- `middleware/auth.js`: `authenticate` (Bearer JWT, profile re-read from the DB).
- `routes/` — `auth.js`, `circles.js`, `listings.js`, `requests.js`, `admin.js` (site admin lists, GET only).
- `services/guestSweep.js`: the daily removal of idle guests and the circles only guests had a part in.
- `src/pages/` — Dashboard, CreateCircle, CircleView, CreateListing, MyListings, RequestsInbox, Admin, Login, Register, AuthCallback.

## Notes
- Open work and known issues: `docs/ROADMAP.md`.
- Working notes for future chats: `CLAUDE.md`.
- Fleet-wide ledger: `docs/PORTFOLIO.md` in the kingfisher repo.
