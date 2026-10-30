import { Router } from 'express';
import pool, { toId } from '../config/db.js';
import { authenticate } from '../middleware/auth.js';
import { wrap } from '../middleware/wrap.js';
import { databaseAnswers } from './health.js';
import { r2Enabled } from '../config/r2.js';
import { SSO_ENABLED } from '../config/sso.js';
import { OWNER_IN_CIRCLE } from '../services/circles.js';

// Site admin (ADMIN_CENTRAL_USER_IDS): look-only lists of everything in the app. Every route
// is a GET; nothing here writes. Join codes stay out, since a code is the key to a circle.
const router = Router();
export const PAGE_SIZE = 50;

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only' });
  next();
});

// The top of /admin, look-only: the deployed commit, whether the database answers, and the
// env-var switches as on or off. Never a value, only whether it is set.
router.get('/status', wrap(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const commit = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7);
  res.json({
    app: 'inner-circle',
    commit: commit || null,
    health: (await databaseAnswers()) ? 'ok' : 'database not answering',
    switches: [
      { name: 'Listing photos (R2)', on: r2Enabled },
      { name: 'Waypoint sign-in', on: SSO_ENABLED },
    ],
  });
}));

class BadQuery extends Error {}

// ?page= is 1-based; missing means the first page.
function pageOf(query) {
  if (query.page === undefined) return 1;
  const page = toId(query.page);
  if (page === null || page < 1) throw new BadQuery('Invalid page');
  return page;
}

// ?q= as an ILIKE pattern that matches the text anywhere, with % and _ taken literally.
function searchOf(query) {
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  return q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
}

function idFilter(query, name) {
  if (query[name] === undefined || query[name] === '') return null;
  const id = toId(query[name]);
  if (id === null) throw new BadQuery(`Invalid ${name}`);
  return id;
}

// Runs one page of `select ... from ... where ...` plus the total count for the same filter.
async function paged(res, page, { select, from, where, params, order }) {
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [{ rows: items }, { rows: [{ total }] }] = await Promise.all([
    pool.query(
      `SELECT ${select} FROM ${from} ${whereSql} ORDER BY ${order}
       LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM ${from} ${whereSql}`, params),
  ]);
  res.json({ items, total, page, page_size: PAGE_SIZE });
}

// Wraps a list route so a bad page or filter answers 400.
const list = (build) => wrap(async (req, res) => {
  let page, spec;
  try {
    page = pageOf(req.query);
    spec = build(req.query);
  } catch (err) {
    if (err instanceof BadQuery) return res.status(400).json({ error: err.message });
    throw err;
  }
  await paged(res, page, spec);
});

// A small builder so each route can add filters with numbered params.
function filters() {
  const where = [];
  const params = [];
  return {
    where,
    params,
    add(sql, value) {
      params.push(value);
      where.push(sql.replaceAll('$?', `$${params.length}`));
    },
  };
}

router.get('/users', list((query) => {
  const f = filters();
  const q = searchOf(query);
  if (q) {
    f.add(`(p.username ILIKE $? OR p.email ILIKE $? OR p.first_name ILIKE $? OR p.last_name ILIKE $?
      OR p.central_user_id::text ILIKE $?)`, q);
  }
  return {
    select: `p.central_user_id, p.username, p.email, p.first_name, p.last_name, p.created_at, p.updated_at,
      (SELECT COUNT(*)::int FROM circle_members WHERE central_user_id = p.central_user_id) AS circle_count,
      (SELECT COUNT(*)::int FROM listings WHERE central_user_id = p.central_user_id) AS listing_count,
      (SELECT COUNT(*)::int FROM requests WHERE from_user_id = p.central_user_id) AS requests_sent`,
    from: 'profiles p',
    ...f,
    order: 'p.created_at DESC, p.id DESC',
  };
}));

router.get('/circles', list((query) => {
  const f = filters();
  const q = searchOf(query);
  if (q) f.add('(c.name ILIKE $? OR c.description ILIKE $? OR cp.username ILIKE $?)', q);
  const userId = idFilter(query, 'user_id');
  if (userId !== null) {
    f.add('EXISTS (SELECT 1 FROM circle_members WHERE circle_id = c.id AND central_user_id = $?)', userId);
  }
  return {
    select: `c.id, c.name, c.description, c.created_by, cp.username AS created_by_username, c.created_at,
      (SELECT COUNT(*)::int FROM circle_members WHERE circle_id = c.id) AS member_count,
      (SELECT COUNT(*)::int FROM listings WHERE circle_id = c.id) AS listing_count,
      (SELECT COUNT(*)::int FROM listings l WHERE l.circle_id = c.id AND l.active AND ${OWNER_IN_CIRCLE}) AS active_listing_count`,
    from: 'circles c JOIN profiles cp ON cp.central_user_id = c.created_by',
    ...f,
    order: 'c.created_at DESC, c.id DESC',
  };
}));

router.get('/members', list((query) => {
  const f = filters();
  const q = searchOf(query);
  if (q) f.add('(p.username ILIKE $? OR p.first_name ILIKE $? OR p.last_name ILIKE $? OR c.name ILIKE $?)', q);
  const circleId = idFilter(query, 'circle_id');
  if (circleId !== null) f.add('cm.circle_id = $?', circleId);
  const userId = idFilter(query, 'user_id');
  if (userId !== null) f.add('cm.central_user_id = $?', userId);
  return {
    select: `cm.id, cm.circle_id, c.name AS circle_name, cm.central_user_id, p.username, p.first_name,
      p.last_name, cm.role, cm.joined_at`,
    from: `circle_members cm
      JOIN circles c ON c.id = cm.circle_id
      JOIN profiles p ON p.central_user_id = cm.central_user_id`,
    ...f,
    order: 'cm.joined_at DESC, cm.id DESC',
  };
}));

router.get('/listings', list((query) => {
  const f = filters();
  const q = searchOf(query);
  if (q) {
    f.add(`(l.title ILIKE $? OR l.description ILIKE $? OR l.availability ILIKE $? OR p.username ILIKE $?
      OR array_to_string(l.tags, ' ') ILIKE $?)`, q);
  }
  const circleId = idFilter(query, 'circle_id');
  if (circleId !== null) f.add('l.circle_id = $?', circleId);
  const userId = idFilter(query, 'user_id');
  if (userId !== null) f.add('l.central_user_id = $?', userId);
  return {
    select: `l.id, l.circle_id, c.name AS circle_name, l.central_user_id, p.username, l.kind, l.category,
      l.title, l.description, l.availability, l.tags, l.active, ${OWNER_IN_CIRCLE} AS owner_in_circle,
      l.created_at, l.updated_at,
      (SELECT COUNT(*)::int FROM requests WHERE listing_id = l.id) AS request_count`,
    from: `listings l
      JOIN circles c ON c.id = l.circle_id
      JOIN profiles p ON p.central_user_id = l.central_user_id`,
    ...f,
    order: 'l.created_at DESC, l.id DESC',
  };
}));

router.get('/requests', list((query) => {
  const f = filters();
  const q = searchOf(query);
  if (q) f.add('(r.message ILIKE $? OR l.title ILIKE $? OR fp.username ILIKE $? OR tp.username ILIKE $?)', q);
  const circleId = idFilter(query, 'circle_id');
  if (circleId !== null) f.add('l.circle_id = $?', circleId);
  const listingId = idFilter(query, 'listing_id');
  if (listingId !== null) f.add('r.listing_id = $?', listingId);
  const userId = idFilter(query, 'user_id');
  if (userId !== null) f.add('(r.from_user_id = $? OR r.to_user_id = $?)', userId);
  return {
    select: `r.id, r.listing_id, l.title AS listing_title, l.kind AS listing_kind, l.circle_id,
      c.name AS circle_name, r.from_user_id, fp.username AS from_username, r.to_user_id,
      tp.username AS to_username, r.message, r.status, r.created_at, r.updated_at`,
    from: `requests r
      JOIN listings l ON l.id = r.listing_id
      JOIN circles c ON c.id = l.circle_id
      JOIN profiles fp ON fp.central_user_id = r.from_user_id
      JOIN profiles tp ON tp.central_user_id = r.to_user_id`,
    ...f,
    order: 'r.created_at DESC, r.id DESC',
  };
}));

export default router;
