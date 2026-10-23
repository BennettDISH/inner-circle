import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// An idle client can error (database restart, dropped connection). Without a listener
// that 'error' event is unhandled and takes the whole server down; the pool drops the
// broken client and makes a new one on the next query.
pool.on('error', (err) => {
  console.error('Postgres idle client error:', err.message);
});
// A client checked out with pool.connect() loses the pool's listener while it is out, so
// the same drop between two queries would still crash. Each client gets its own listener
// for life; its next query fails and the route's error handling answers.
pool.on('connect', (client) => {
  client.on('error', (err) => console.error('Postgres client error:', err.message));
});

// Every id column is SERIAL or INTEGER (int4). A fraction or a number outside that range
// makes Postgres fail the query, so routes check ids with this first. Returns the id as a
// number, or null when it can't be one.
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;
export function toId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id >= INT4_MIN && id <= INT4_MAX ? id : null;
}

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id SERIAL PRIMARY KEY,
      central_user_id INTEGER UNIQUE NOT NULL,
      username VARCHAR(100) NOT NULL,
      email VARCHAR(255),
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Central accounts may have no email (the auth-service made it optional), so the local
    -- mirror must accept NULL. Widening only — safe to re-run on every boot.
    ALTER TABLE profiles ALTER COLUMN email DROP NOT NULL;

    -- bio was never read or written by any UI; drop it from existing databases too.
    -- Idempotent — safe to re-run on every boot.
    ALTER TABLE profiles DROP COLUMN IF EXISTS bio;

    CREATE TABLE IF NOT EXISTS circles (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT DEFAULT '',
      join_code VARCHAR(20) UNIQUE NOT NULL,
      created_by INTEGER NOT NULL REFERENCES profiles(central_user_id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS circle_members (
      id SERIAL PRIMARY KEY,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      central_user_id INTEGER NOT NULL REFERENCES profiles(central_user_id),
      role VARCHAR(20) DEFAULT 'member',
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(circle_id, central_user_id)
    );

    CREATE TABLE IF NOT EXISTS listings (
      id SERIAL PRIMARY KEY,
      circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
      central_user_id INTEGER NOT NULL REFERENCES profiles(central_user_id),
      kind VARCHAR(20) NOT NULL DEFAULT 'have',
      category VARCHAR(50) DEFAULT 'item',
      title VARCHAR(255) NOT NULL,
      description TEXT DEFAULT '',
      availability TEXT DEFAULT '',
      tags TEXT[] DEFAULT '{}',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS requests (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      from_user_id INTEGER NOT NULL REFERENCES profiles(central_user_id),
      to_user_id INTEGER NOT NULL REFERENCES profiles(central_user_id),
      message TEXT DEFAULT '',
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Up to four photos per listing, as objects in the private R2 bucket (circles/<circle>/<random>).
    -- The row is the access rule: the app streams an object only to a circle member.
    CREATE TABLE IF NOT EXISTS listing_photos (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      object_key TEXT NOT NULL UNIQUE,
      content_type VARCHAR(50) NOT NULL,
      bytes INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_listing_photos_listing ON listing_photos(listing_id, position);

    CREATE INDEX IF NOT EXISTS idx_listings_circle ON listings(circle_id);
    CREATE INDEX IF NOT EXISTS idx_listings_user ON listings(central_user_id);
    CREATE INDEX IF NOT EXISTS idx_listings_kind ON listings(kind);
    CREATE INDEX IF NOT EXISTS idx_requests_listing ON requests(listing_id);
    CREATE INDEX IF NOT EXISTS idx_requests_to ON requests(to_user_id);
    -- Every foreign key column leads an index (test/api.test.js checks): the circle list looks
    -- members up by user, outgoing requests by sender, and deleting a profile (the guest sweep)
    -- has Postgres check each key that names it.
    CREATE INDEX IF NOT EXISTS idx_members_user ON circle_members(central_user_id);
    CREATE INDEX IF NOT EXISTS idx_requests_from ON requests(from_user_id);
    CREATE INDEX IF NOT EXISTS idx_circles_created_by ON circles(created_by);
  `);
}

export default pool;
