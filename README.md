# inner-circle

A trusted network for friends and family to share what they **have**, **need**, and **offer**. Create
circles, post listings, and manage incoming requests.

## Stack
React 19 + Vite · Express · Postgres · SSO via `auth-service`

## Getting started
```bash
npm install
cp .env.example .env      # DATABASE_URL, JWT_SECRET, AUTH_SERVICE_URL, SSO_CLIENT_ID/SECRET,
                          # VITE_AUTH_SERVICE_URL, VITE_SSO_CLIENT_ID

npm run server            # Express API (node --watch server.js)
npm run dev               # Vite dev server
```

Production: `npm run build` then `npm start`.

## Layout
- `src/pages/` — Dashboard, CreateCircle, CircleView, CreateListing, MyListings, RequestsInbox, Login, Register, AuthCallback.
- `routes/` — `auth.js`, `circles.js`, `listings.js`, `requests.js`.

## Deploy
Railway.

## Notes
Auth via `auth-service` (SSO). See `../PORTFOLIO.md`.
