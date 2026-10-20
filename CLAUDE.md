# inner-circle

Friends-and-family sharing app: people join circles by code and post what they have or need; others send requests on a listing. Express 4 serves the built React 19 app and a JSON API. Live on Railway at https://inner-circle-production-a7f8.up.railway.app. Default branch is `master`.

## Commands
```bash
npm run server       # node --watch server.js (API on PORT, default 3000)
npm run dev          # Vite dev server, proxies /api to localhost:3000
npm run build        # vite build -> dist/
npm start            # node server.js (serves dist/ + /api)
npm test             # node --test test/*.test.js
```
`npm test` spawns the real `server.js` against PGlite served over the Postgres wire protocol, with a stand-in Waypoint for guest, register/login and the code exchange (`test/helpers.js`, which pins every env var the server reads). The helper drops the extra ReadyForQuery PGlite sends after an extended-protocol error; without that, the ROLLBACK in circle create gets out of step with `pg` and the server dies. `test/db.test.js` checks the pool on its own in a child process. No lint script. A local run needs Postgres in `DATABASE_URL` and the Waypoint vars, since every sign-in goes through the auth service.

## Key files
- `server.js`: `trust proxy` on, helmet (CSP off), open CORS, morgan, JSON body; routers under `/api/auth`, `/api/circles`, `/api/listings`, `/api/requests`, `/api/admin`; `/health`; SPA fallback. Boot runs `initDb()` first and exits if it fails.
- `config/db.js`: the pool (its `error` listener logs a dropped idle connection instead of crashing), `toId()` (routes check every id with it: an int4 or null, which they answer with 400), and the whole schema, applied on every boot. No migrations; keep changes idempotent (`IF NOT EXISTS`, `DROP COLUMN IF EXISTS`).
- `config/sso.js`: `centralRegister`, `centralLogin`, `centralGuest`, `exchangeCode`. `SSO_ENABLED` needs all three SSO vars.
- `middleware/auth.js`: `authenticate` verifies the Bearer JWT (`{ central_user_id, username }`) and loads the profile; `req.user.is_admin` comes from `ADMIN_CENTRAL_USER_IDS`.
- `routes/auth.js`: config, SSO start, register/login (proxied to Waypoint), sso-callback, guest, profile. `findOrCreateProfile` mirrors the Waypoint account into `profiles`.
- `routes/circles.js`: list mine, create (creator becomes circle `admin`), join by code, view (members only), leave.
- `routes/listings.js`: list by circle (members only), create, update/delete (owner only), mine.
- `routes/requests.js`: create on a listing in a circle you're in, list incoming/outgoing, update status (only the recipient accepts or declines).
- `routes/admin.js`: site admin lists under `/api/admin` (users, circles, members, listings, requests), GET only, 403 unless `req.user.is_admin`. Each answers `{ items, total, page, page_size }` (50 a page) and takes `q` (ILIKE anywhere, `%` and `_` literal), `page` and id filters. Join codes never come out. `src/pages/Admin.jsx` is the page; the nav shows it to admins.
- `src/services/api.js`: fetch wrapper that adds the token from localStorage.
- `src/contexts/AuthContext.jsx`, `src/components/ProtectedRoute.jsx`: session and route guard.

## Conventions and gotchas
- Users are keyed by `central_user_id` everywhere (all foreign keys point at `profiles.central_user_id`), not by a local id.
- There are no local passwords: register and login are proxied to Waypoint; the app only issues its own JWT afterwards.
- Membership is the access rule: check `circle_members` before showing anything in a circle.
- Listing kinds are `have` and `need`; categories are validated against `VALID_CATEGORIES` in `routes/listings.js`.
- `is_admin` (from `ADMIN_CENTRAL_USER_IDS`; unset means nobody) only opens the look-only admin lists. It gives no member or owner powers inside circles.
- Join codes are 6 random base-36 characters from `Math.random`.
- The Railway build installs devDependencies on purpose: vite is a devDependency.
- Env vars are named in the README and explained in `.env.example`. Never commit `.env`.

## Current state
Dormant since 2026-09-02 (a fix wave: member list, leave circle, OAuth state check, listing validation). Live and healthy. Open items live in `docs/ROADMAP.md`.
