import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const dbPath = process.env.DB_PATH ?? fileURLToPath(new URL('data/lego.db', root));

mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000'); // api and worker share this file
db.pragma('foreign_keys = ON');

db.exec(`
-- Full LEGO catalog, imported from Rebrickable (see catalog.ts).
CREATE TABLE IF NOT EXISTS sets (
  set_number TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  theme      TEXT,
  year       INTEGER,
  pieces     INTEGER,
  img_url    TEXT
);

-- Every pincode that has been requested. The worker scrapes all of them.
CREATE TABLE IF NOT EXISTS pincodes (
  pincode TEXT PRIMARY KEY,
  city    TEXT NOT NULL,
  lat     REAL NOT NULL,
  lng     REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  set_number          TEXT NOT NULL REFERENCES sets(set_number),
  platform            TEXT NOT NULL,
  platform_product_id TEXT NOT NULL,
  title               TEXT NOT NULL,
  url                 TEXT NOT NULL,
  brand               TEXT,
  UNIQUE (platform, platform_product_id)
);

-- Append-only price history, one row per listing, pincode and fetch.
CREATE TABLE IF NOT EXISTS prices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  pincode    TEXT NOT NULL REFERENCES pincodes(pincode),
  price      REAL NOT NULL,
  mrp        REAL,
  in_stock   INTEGER NOT NULL,
  -- when this price/stock state first appeared
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- last time a crawl confirmed it (refreshed every run while unchanged)
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_prices_lookup ON prices (listing_id, pincode, id DESC);

-- Coordinates for every Indian pincode from GeoNames (see geo.ts).
CREATE TABLE IF NOT EXISTS geo_pincodes (
  pincode TEXT PRIMARY KEY,
  city    TEXT NOT NULL,
  lat     REAL NOT NULL,
  lng     REAL NOT NULL
);

-- The point that worked (or failed) for a coordinate-keyed platform at a pincode.
CREATE TABLE IF NOT EXISTS serving (
  platform   TEXT NOT NULL,
  pincode    TEXT NOT NULL,
  lat        REAL,
  lng        REAL,
  ok         INTEGER NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (platform, pincode)
);

-- Last successful crawl per platform and pincode (drives per-platform intervals).
CREATE TABLE IF NOT EXISTS crawls (
  platform    TEXT NOT NULL,
  pincode     TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  PRIMARY KEY (platform, pincode)
);

-- "Fetch live rates" requests from the website. The API queues them, the worker runs them.
CREATE TABLE IF NOT EXISTS refresh_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pincode      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  progress     TEXT NOT NULL DEFAULT '{}',     -- JSON: platform id -> { state, listings?, error? }
  error        TEXT,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at   TEXT,
  finished_at  TEXT
);

-- LEGO products (never other brands) that could not be tied to exactly one catalog set.
CREATE TABLE IF NOT EXISTS unmatched (
  platform            TEXT NOT NULL,
  platform_product_id TEXT NOT NULL,
  title               TEXT NOT NULL,
  url                 TEXT NOT NULL,
  seen_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (platform, platform_product_id)
);
`);

// Migration for databases created before checked_at existed.
// (SQLite cannot add a column with a non-constant default, so add it plain and backfill.)
const priceCols = db.prepare('PRAGMA table_info(prices)').all() as { name: string }[];
if (!priceCols.some((c) => c.name === 'checked_at')) {
  db.exec('ALTER TABLE prices ADD COLUMN checked_at TEXT');
  db.exec('UPDATE prices SET checked_at = fetched_at');
}

// Migration: listings gained a brand column (the brand each platform reports for the product).
const listingCols = db.prepare('PRAGMA table_info(listings)').all() as { name: string }[];
if (!listingCols.some((c) => c.name === 'brand')) db.exec('ALTER TABLE listings ADD COLUMN brand TEXT');

// Migration: pincodes remember when someone last looked at them, so scheduled crawls can skip
// pincodes nobody is using (see scrape.ts ACTIVE_DAYS).
const pinCols = db.prepare('PRAGMA table_info(pincodes)').all() as { name: string }[];
if (!pinCols.some((c) => c.name === 'last_viewed_at')) {
  db.exec('ALTER TABLE pincodes ADD COLUMN last_viewed_at TEXT');
  db.exec("UPDATE pincodes SET last_viewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
}
