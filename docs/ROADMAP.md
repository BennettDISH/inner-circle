# Roadmap

Open ideas, planned work and known issues. One line each.

## Open
- No tests for the client (the API has a suite in `test/`).
- A circle whose last admin leaves has no admin left, and there is no way to remove a member or change a join code.

## Done
- Circle names and listing titles checked at 255 characters (plain 400, input maxLength); join codes drawn with `crypto.randomInt`, one retry on a clash (2026-10-22).
- Requests: refused on an inactive listing and a second pending one from the same person (409); the sender can only cancel, only the listing owner accepts, declines or completes (2026-10-22).
- Content-Security-Policy on (script-src self and the bug-tracker widget; no inline script), since the session token sits in localStorage (2026-10-22).
- 10 wrong join codes per 15 minutes per address and per account, 5 guest sign-ins an hour per address; `trust proxy` narrowed to Railway's one hop (2026-10-22).
- Unknown `/api` paths answer a JSON 404; sign-in upserts the profile in one statement; a listing edit can't blank the title or send a non-boolean `active`; every foreign key column is indexed (2026-10-21).
- Signed-in pages at phone width (nav, circle header, tabs, no iPhone focus zoom) and for keyboard and screen readers (join code button, main landmark, aria-current/aria-pressed, role="alert" errors) (2026-10-21).
- Form labels tied to their fields on every page (2026-10-19, 2026-10-21).
- Guest sweep: Waypoint guests idle for 30 days go, with circles only guests had a part in (2026-10-20).
- Site admin page (`/admin`, ADMIN_CENTRAL_USER_IDS): look-only lists of users, circles, members, listings and requests, with search and 50 a page; join codes stay out (2026-10-20).
- First API test suite: auth, circles, listings, requests, malformed ids, bad input (2026-10-19).
- Circle member list and a Leave Circle action on CircleView (2026-08-31).
- OAuth state checked before the code exchange (2026-08-31).
- Listing kind/category validated on update; vestigial `skill` kind and the unused bio column removed (2026-08-31).
- One-click guest sign-in (2026-07-23); central accounts with no email tolerated (2026-07-22).
- SSO authorize URL built server-side, no `VITE_*` vars (2026-07-14).
