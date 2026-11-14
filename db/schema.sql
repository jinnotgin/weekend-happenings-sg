-- Registry schema: stable IDs for venues and events across scraper runs.
-- Works on both Cloudflare D1 and local SQLite (node:sqlite). The pipeline applies it
-- automatically on start (every statement is idempotent), so running it by hand is optional:
--   npx wrangler d1 execute <db-name> --remote --file=db/schema.sql

-- One row per real-world place. IDs are never deleted: the frontend stores them as stars.
-- A duplicate is retired by pointing merged_into at the surviving venue.
CREATE TABLE IF NOT EXISTS venues (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	region TEXT,
	lat REAL,
	lng REAL,
	nearest_mrt TEXT,
	maps_url TEXT,
	locate_attempts INTEGER NOT NULL DEFAULT 0,
	first_seen TEXT NOT NULL,
	last_seen TEXT NOT NULL,
	merged_into TEXT REFERENCES venues(id)
);

-- Every normalised spelling the scraper has produced for a venue ("asian civilisations museum",
-- "sands theatre marina bay sands", ...). Exact alias hits skip the LLM entirely.
CREATE TABLE IF NOT EXISTS venue_aliases (
	alias TEXT PRIMARY KEY,
	venue_id TEXT NOT NULL REFERENCES venues(id),
	raw_name TEXT NOT NULL,
	first_seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_venue_aliases_venue ON venue_aliases(venue_id);

-- One row per event. Mutable fields (description, datetime, daterange, ...) are overwritten
-- each time the event is seen again; the id stays.
CREATE TABLE IF NOT EXISTS events (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	title_key TEXT NOT NULL,
	description TEXT,
	datetime TEXT,
	date_start TEXT,
	date_end TEXT,
	daterange_json TEXT,
	category_json TEXT,
	venue_ids_json TEXT,
	link TEXT,
	thumbnail TEXT,
	thumbnail_key TEXT,
	first_seen TEXT NOT NULL,
	last_seen TEXT NOT NULL,
	seen_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_events_last_seen ON events(last_seen);

CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT
);
