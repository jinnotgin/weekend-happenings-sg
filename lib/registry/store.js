import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeVenueName, normalizeEventTitle, slugify } from "./normalize.js";

// In-memory view of the registry for one run. Load everything once (a few hundred venues,
// recent events), mutate in memory, then write only what changed in a single commit().
// This keeps D1 to a handful of HTTP calls per run regardless of event count.

const SCHEMA_VERSION = "1";
const SCHEMA_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"db",
	"schema.sql"
);
// Events not seen for this long are neither loaded nor matched against: their IDs age out
// (rows stay in the database). Shared with resolve-events.js.
export const EVENT_MATCH_WINDOW_DAYS = 60;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function toIsoDate(date = new Date()) {
	// Local calendar date (the workflow runs with TZ=Asia/Singapore).
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function addDays(isoDate, days) {
	const [year, month, day] = isoDate.split("-").map(Number);
	return toIsoDate(new Date(year, month - 1, day + days));
}

// "22 Feb 2026" -> "2026-02-22". The pipeline uses 01 Jan 1970 for "no start"; that maps to null.
export function parseDisplayDate(value) {
	if (typeof value !== "string") return null;
	const match = value.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/);
	if (!match) return null;
	const monthIndex = MONTHS.indexOf(match[2].toLowerCase());
	if (monthIndex < 0) return null;
	const year = Number(match[3]);
	if (year <= 1970) return null;
	return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function readSchemaStatements() {
	const sql = fs.readFileSync(SCHEMA_PATH, "utf-8");
	return sql
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean)
		.map((statement) => ({ sql: statement }));
}

function parseJson(value, fallback) {
	if (typeof value !== "string" || value.length === 0) return fallback;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function randomId(length = 10) {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
	let id = "";
	for (let index = 0; index < length; index++) {
		id += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return id;
}

export class Registry {
	constructor({ executor, durable, today }) {
		this.executor = executor;
		this.durable = durable;
		this.today = today;
		this.venues = new Map();
		this.aliases = new Map();
		this.events = new Map();
		this.dirtyVenues = new Set();
		this.newAliases = new Map();
		this.dirtyEvents = new Set();
		this.stats = { newVenues: 0, newAliases: 0, newEvents: 0, matchedEvents: 0 };
	}

	static async open({ executor, durable = false, today = toIsoDate() }) {
		const registry = new Registry({ executor, durable, today });
		await executor.batch(readSchemaStatements());
		await registry.load();
		return registry;
	}

	async load() {
		const [venueRows, aliasRows, eventRows] = await Promise.all([
			this.executor.all("SELECT * FROM venues"),
			this.executor.all("SELECT alias, venue_id FROM venue_aliases"),
			this.executor.all("SELECT * FROM events WHERE last_seen >= ?", [
				addDays(this.today, -EVENT_MATCH_WINDOW_DAYS),
			]),
		]);
		for (const row of venueRows) {
			this.venues.set(row.id, {
				id: row.id,
				name: row.name,
				region: row.region ?? null,
				lat: row.lat ?? null,
				lng: row.lng ?? null,
				nearestMrt: row.nearest_mrt ?? null,
				mapsUrl: row.maps_url ?? null,
				locateAttempts: Number(row.locate_attempts ?? 0),
				firstSeen: row.first_seen,
				lastSeen: row.last_seen,
				mergedInto: row.merged_into ?? null,
			});
		}
		for (const row of aliasRows) {
			this.aliases.set(row.alias, row.venue_id);
		}
		for (const row of eventRows) {
			this.events.set(row.id, {
				id: row.id,
				title: row.title,
				titleKey: row.title_key,
				description: row.description ?? null,
				datetime: row.datetime ?? null,
				dateStart: row.date_start ?? null,
				dateEnd: row.date_end ?? null,
				daterange: parseJson(row.daterange_json, null),
				category: parseJson(row.category_json, []),
				venueIds: parseJson(row.venue_ids_json, []),
				link: row.link ?? null,
				thumbnail: row.thumbnail ?? null,
				thumbnailKey: row.thumbnail_key ?? null,
				firstSeen: row.first_seen,
				lastSeen: row.last_seen,
				seenCount: Number(row.seen_count ?? 1),
			});
		}
	}

	// ---------- venues ----------

	// Follows merged_into chains to the surviving venue (cycle-safe).
	canonicalVenueId(id) {
		const seen = new Set();
		let current = id;
		while (current && !seen.has(current)) {
			seen.add(current);
			const venue = this.venues.get(current);
			if (!venue?.mergedInto) return venue ? current : null;
			current = venue.mergedInto;
		}
		return null;
	}

	getVenue(id) {
		const canonicalId = this.canonicalVenueId(id);
		return canonicalId ? this.venues.get(canonicalId) : null;
	}

	findVenueByName(rawName) {
		const alias = normalizeVenueName(rawName);
		if (!alias) return null;
		const venueId = this.aliases.get(alias);
		return venueId ? this.getVenue(venueId) : null;
	}

	activeVenues() {
		return [...this.venues.values()].filter((venue) => !venue.mergedInto);
	}

	addAlias(rawName, venueId) {
		const alias = normalizeVenueName(rawName);
		if (!alias || this.aliases.has(alias)) return;
		this.aliases.set(alias, venueId);
		this.newAliases.set(alias, { venueId, rawName });
		this.stats.newAliases += 1;
	}

	createVenue(name, rawNames = []) {
		const base = `v_${slugify(name)}`;
		let id = base;
		for (let suffix = 2; this.venues.has(id); suffix++) {
			id = `${base}-${suffix}`;
		}
		const venue = {
			id,
			name,
			region: null,
			lat: null,
			lng: null,
			nearestMrt: null,
			mapsUrl: null,
			locateAttempts: 0,
			firstSeen: this.today,
			lastSeen: this.today,
			mergedInto: null,
		};
		this.venues.set(id, venue);
		this.dirtyVenues.add(id);
		this.stats.newVenues += 1;
		for (const rawName of [name, ...rawNames]) {
			this.addAlias(rawName, id);
		}
		return venue;
	}

	touchVenue(id) {
		const venue = this.getVenue(id);
		if (!venue || venue.lastSeen === this.today) return;
		venue.lastSeen = this.today;
		this.dirtyVenues.add(venue.id);
	}

	needsLocation(id) {
		const venue = this.getVenue(id);
		return Boolean(venue) && (venue.lat === null || venue.lng === null) && venue.locateAttempts < 3;
	}

	setVenueLocation(id, location) {
		const venue = this.getVenue(id);
		if (!venue) return;
		venue.locateAttempts += 1;
		if (location) {
			venue.region = location.approximate_region ?? venue.region;
			venue.lat = location.approximate_gps?.lat ?? venue.lat;
			venue.lng = location.approximate_gps?.lng ?? venue.lng;
			venue.nearestMrt = location.approximate_nearest_mrt ?? venue.nearestMrt;
			venue.mapsUrl = location.google_maps_url ?? venue.mapsUrl;
		}
		this.dirtyVenues.add(venue.id);
	}

	mergeVenue(fromId, intoId) {
		const from = this.venues.get(fromId);
		const intoCanonical = this.canonicalVenueId(intoId);
		if (!from || !intoCanonical || this.canonicalVenueId(fromId) === intoCanonical) {
			throw new Error(`Cannot merge ${fromId} into ${intoId}`);
		}
		from.mergedInto = intoCanonical;
		this.dirtyVenues.add(fromId);
	}

	// Location fields in the shape events.json has always used.
	venueLocationFields(id) {
		const venue = this.getVenue(id);
		if (!venue) return null;
		return {
			venue_id: venue.id,
			venue_name: venue.name,
			approximate_region: venue.region,
			approximate_gps:
				venue.lat !== null || venue.lng !== null ? { lat: venue.lat, lng: venue.lng } : null,
			approximate_nearest_mrt: venue.nearestMrt,
			google_maps_url: venue.mapsUrl,
		};
	}

	// venues.json for the frontend: every live venue plus redirects for merged IDs.
	exportPublicVenues() {
		const venues = this.activeVenues()
			.map((venue) => ({
				id: venue.id,
				name: venue.name,
				approximate_region: venue.region,
				approximate_gps:
					venue.lat !== null || venue.lng !== null ? { lat: venue.lat, lng: venue.lng } : null,
				approximate_nearest_mrt: venue.nearestMrt,
				google_maps_url: venue.mapsUrl,
				last_seen: venue.lastSeen,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
		const redirects = {};
		for (const venue of this.venues.values()) {
			if (!venue.mergedInto) continue;
			const target = this.canonicalVenueId(venue.id);
			if (target) redirects[venue.id] = target;
		}
		return { venues, redirects };
	}

	// ---------- events ----------

	createEventId() {
		let id;
		do {
			id = `e_${randomId()}`;
		} while (this.events.has(id));
		return id;
	}

	// Inserts or refreshes an event. `matchedId` keeps an existing identity.
	upsertEvent(event, matchedId = null) {
		const existing = matchedId ? this.events.get(matchedId) : null;
		const id = existing?.id ?? this.createEventId();
		const daterange = Array.isArray(event.daterange) ? event.daterange : existing?.daterange ?? null;
		const record = {
			id,
			title: event.title,
			titleKey: normalizeEventTitle(event.title),
			description: event.description ?? null,
			datetime: event.datetime ?? null,
			dateStart: daterange ? parseDisplayDate(daterange[0]) : null,
			dateEnd: daterange ? parseDisplayDate(daterange[1]) : null,
			daterange,
			category: Array.isArray(event.category) ? event.category : [],
			venueIds: (event.locations ?? []).map((location) => location?.venue_id).filter(Boolean),
			link: event.link ?? existing?.link ?? null,
			thumbnail: event.thumbnail ?? existing?.thumbnail ?? null,
			thumbnailKey: event.thumbnail
				? event.thumbnail === existing?.thumbnail
					? existing?.thumbnailKey ?? null
					: null
				: existing?.thumbnailKey ?? null,
			firstSeen: existing?.firstSeen ?? this.today,
			lastSeen: this.today,
			seenCount: existing
				? existing.lastSeen === this.today
					? existing.seenCount
					: existing.seenCount + 1
				: 1,
		};
		this.events.set(id, record);
		this.dirtyEvents.add(id);
		if (existing) this.stats.matchedEvents += 1;
		else this.stats.newEvents += 1;
		return record;
	}

	// After upload: remember where this run stored each thumbnail so a later run can reuse it.
	setThumbnailKeys(keyForFilename) {
		for (const id of this.dirtyEvents) {
			const event = this.events.get(id);
			if (event?.thumbnail && event.lastSeen === this.today) {
				event.thumbnailKey = keyForFilename(event.thumbnail);
			}
		}
	}

	// ---------- persistence ----------

	buildCommitStatements() {
		const statements = [];
		for (const id of this.dirtyVenues) {
			const venue = this.venues.get(id);
			statements.push({
				sql: `INSERT INTO venues (id, name, region, lat, lng, nearest_mrt, maps_url, locate_attempts, first_seen, last_seen, merged_into)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET name = excluded.name, region = excluded.region, lat = excluded.lat,
lng = excluded.lng, nearest_mrt = excluded.nearest_mrt, maps_url = excluded.maps_url,
locate_attempts = excluded.locate_attempts, last_seen = excluded.last_seen, merged_into = excluded.merged_into`,
				params: [
					venue.id,
					venue.name,
					venue.region,
					venue.lat,
					venue.lng,
					venue.nearestMrt,
					venue.mapsUrl,
					venue.locateAttempts,
					venue.firstSeen,
					venue.lastSeen,
					venue.mergedInto,
				],
			});
		}
		for (const [alias, { venueId, rawName }] of this.newAliases) {
			statements.push({
				sql: "INSERT OR IGNORE INTO venue_aliases (alias, venue_id, raw_name, first_seen) VALUES (?, ?, ?, ?)",
				params: [alias, venueId, rawName, this.today],
			});
		}
		for (const id of this.dirtyEvents) {
			const event = this.events.get(id);
			statements.push({
				sql: `INSERT INTO events (id, title, title_key, description, datetime, date_start, date_end, daterange_json,
category_json, venue_ids_json, link, thumbnail, thumbnail_key, first_seen, last_seen, seen_count)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET title = excluded.title, title_key = excluded.title_key,
description = excluded.description, datetime = excluded.datetime, date_start = excluded.date_start,
date_end = excluded.date_end, daterange_json = excluded.daterange_json, category_json = excluded.category_json,
venue_ids_json = excluded.venue_ids_json, link = excluded.link, thumbnail = excluded.thumbnail,
thumbnail_key = excluded.thumbnail_key, last_seen = excluded.last_seen, seen_count = excluded.seen_count`,
				params: [
					event.id,
					event.title,
					event.titleKey,
					event.description,
					event.datetime,
					event.dateStart,
					event.dateEnd,
					event.daterange ? JSON.stringify(event.daterange) : null,
					JSON.stringify(event.category),
					JSON.stringify(event.venueIds),
					event.link,
					event.thumbnail,
					event.thumbnailKey,
					event.firstSeen,
					event.lastSeen,
					event.seenCount,
				],
			});
		}
		statements.push({
			sql: "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			params: [SCHEMA_VERSION],
		});
		statements.push({
			sql: "INSERT INTO meta (key, value) VALUES ('last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			params: [new Date().toISOString()],
		});
		return statements;
	}

	async commit() {
		const statements = this.buildCommitStatements();
		await this.executor.batch(statements);
		this.dirtyVenues.clear();
		this.newAliases.clear();
		this.dirtyEvents.clear();
		return statements.length;
	}
}
