import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      id SERIAL PRIMARY KEY,
      central_user_id INTEGER UNIQUE NOT NULL,
      username VARCHAR(100) NOT NULL,
      email VARCHAR(255),
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      bio TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Central accounts may have no email (the auth-service made it optional), so the local
    -- mirror must accept NULL. Widening only — safe to re-run on every boot.
    ALTER TABLE profiles ALTER COLUMN email DROP NOT NULL;

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

    CREATE INDEX IF NOT EXISTS idx_listings_circle ON listings(circle_id);
    CREATE INDEX IF NOT EXISTS idx_listings_user ON listings(central_user_id);
    CREATE INDEX IF NOT EXISTS idx_listings_kind ON listings(kind);
    CREATE INDEX IF NOT EXISTS idx_requests_listing ON requests(listing_id);
    CREATE INDEX IF NOT EXISTS idx_requests_to ON requests(to_user_id);
  `);
}

export default pool;
