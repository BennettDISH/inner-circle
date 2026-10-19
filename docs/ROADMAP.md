# Roadmap

Open ideas, planned work and known issues. One line each.

## Open
- No tests for the client (the API has a suite in `test/`).
- Over-long names and titles (VARCHAR limits) reach Postgres: circle create answers 400 with the raw Postgres message, listing create answers 500.
- `ADMIN_CENTRAL_USER_IDS` sets `req.user.is_admin`, but nothing uses it yet.
- Join codes come from `Math.random` and there is no rate limit on `POST /api/circles/join`.
- A circle whose last admin leaves has no admin left, and there is no way to remove a member or change a join code.
- Requests can be sent on inactive listings.

## Done
- First API test suite: auth, circles, listings, requests, malformed ids, bad input (2026-10-19).
- Circle member list and a Leave Circle action on CircleView (2026-08-31).
- OAuth state checked before the code exchange (2026-08-31).
- Listing kind/category validated on update; vestigial `skill` kind and the unused bio column removed (2026-08-31).
- One-click guest sign-in (2026-07-23); central accounts with no email tolerated (2026-07-22).
- SSO authorize URL built server-side, no `VITE_*` vars (2026-07-14).
