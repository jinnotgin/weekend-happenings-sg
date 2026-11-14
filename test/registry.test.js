import { test } from "node:test";
import assert from "node:assert/strict";
import { createSqliteExecutor } from "../lib/registry/executors.js";
import { Registry, parseDisplayDate } from "../lib/registry/store.js";
import {
	normalizeVenueName,
	isVagueVenueName,
	normalizeEventTitle,
	tokenSimilarity,
} from "../lib/registry/normalize.js";
import { resolveVenuesForEvents } from "../lib/registry/resolve-venues.js";
import { matchEventsToRegistry, reusableDateRange } from "../lib/registry/resolve-events.js";
import { locateRegistryVenues } from "../lib/locate-venues.js";

async function openMemoryRegistry(today = "2026-11-14", executor = null) {
	const sqlite = executor ?? (await createSqliteExecutor(":memory:"));
	return { registry: await Registry.open({ executor: sqlite, today }), executor: sqlite };
}

// Fake LLM for RESOLVE_VENUES: groups names whose normalised first segment is equal, matches
// the top candidate when it shares that first segment, and marks nothing as a non-place.
function fakeVenueLlm(prompt) {
	const { names } = JSON.parse(prompt);
	const firstSegment = (name) => normalizeVenueName(name.split(",")[0].replace(/\s*\(ACM\)/g, ""));
	const groups = new Map();
	for (const item of names) {
		const key = firstSegment(item.name);
		const match = item.candidates.find((candidate) => firstSegment(candidate.name) === key);
		const group = groups.get(key) ?? {
			keys: [],
			match_venue_id: match?.id ?? null,
			canonical_name: match ? null : item.name.split(",")[0].trim(),
			is_place: true,
		};
		group.keys.push(item.key);
		groups.set(key, group);
	}
	return Promise.resolve({ parsedJson: { groups: [...groups.values()] } });
}

const failingLlm = () => Promise.reject(new Error("LLM unavailable"));

test("normalizeVenueName strips addresses and units while preserving qualifiers", () => {
	assert.equal(normalizeVenueName("Asian Civilisations Museum, 1 Empress Place"), "asian civilisations museum");
	assert.equal(normalizeVenueName("Asian Civilisations Museum"), "asian civilisations museum");
	assert.equal(
		normalizeVenueName("Changi Point Ferry Terminal, 51 Lor Bekukong, Singapore 499172"),
		"changi point ferry terminal"
	);
	assert.equal(normalizeVenueName("National Gallery Singapore, 1 St Andrew's Road"), "national gallery");
	assert.equal(normalizeVenueName("Alliance Française de Singapour"), "alliance francaise de singapour");
	assert.equal(normalizeVenueName("Arena @ Expo"), "arena at expo");
});

test("vague venue names are detected", () => {
	for (const name of ["Various locations", "Online", "Islandwide", "TBA", "Singapore", ""]) {
		assert.equal(isVagueVenueName(name), true, name);
	}
	for (const name of ["Orchard Road", "Rail Corridor", "Singapore Indoor Stadium"]) {
		assert.equal(isVagueVenueName(name), false, name);
	}
});

test("event titles ignore years and punctuation", () => {
	assert.equal(normalizeEventTitle("Singapore Night Festival 2026"), normalizeEventTitle("Singapore Night Festival!"));
	assert.ok(tokenSimilarity("sands theatre at marina bay sands", "sands theatre marina bay sands") > 0.8);
});

test("parseDisplayDate maps pipeline dates and the 1970 sentinel", () => {
	assert.equal(parseDisplayDate("22 Feb 2026"), "2026-02-22");
	assert.equal(parseDisplayDate("01 Jan 1970"), null);
	assert.equal(parseDisplayDate("soon"), null);
});

test("venues keep the same ID across runs and spellings", async () => {
	const executor = await createSqliteExecutor(":memory:");

	// Run 1
	const run1 = (await openMemoryRegistry("2026-11-10", executor)).registry;
	const eventsRun1 = [
		{ title: "A", locations: [{ name: "Asian Civilisations Museum" }, { name: "Online" }] },
		{ title: "B", locations: [{ name: "Singapore EXPO, Hall 6" }] },
		{ title: "C", locations: [{ name: "Asian Civilisations Museum, 1 Empress Place" }] },
	];
	await resolveVenuesForEvents(eventsRun1, run1, { llm: fakeVenueLlm });
	const acmId = eventsRun1[0].locations[0].venue_id;
	assert.ok(acmId?.startsWith("v_asian-civilisations-museum"));
	assert.equal(eventsRun1[0].locations[1].venue_id, null, "Online gets no venue");
	assert.equal(eventsRun1[2].locations[0].venue_id, acmId, "address variant -> same venue");
	await run1.commit();

	// Run 2: new spellings, same places
	const run2 = (await openMemoryRegistry("2026-11-14", executor)).registry;
	assert.equal(run2.venues.size, 2);
	const eventsRun2 = [
		{ title: "D", locations: [{ name: "Asian Civilisations Museum (ACM), Empress Place" }] },
		{ title: "E", locations: [{ name: "Singapore EXPO, Hall 3" }] },
	];
	await resolveVenuesForEvents(eventsRun2, run2, { llm: fakeVenueLlm });
	assert.equal(eventsRun2[0].locations[0].venue_id, acmId);
	assert.equal(eventsRun2[1].locations[0].venue_id, eventsRun1[1].locations[0].venue_id);
	assert.equal(run2.stats.newVenues, 0);
	assert.equal(run2.venues.get(acmId).lastSeen, "2026-11-14");
});

test("deterministic fallback assigns IDs when the LLM fails", async () => {
	const { registry } = await openMemoryRegistry();
	const events = [
		{ title: "A", locations: [{ name: "Funan" }] },
		{ title: "B", locations: [{ name: "Funan, #01-01" }] },
	];
	await resolveVenuesForEvents(events, registry, { llm: failingLlm });
	assert.ok(events[0].locations[0].venue_id);
	assert.equal(events[0].locations[0].venue_id, events[1].locations[0].venue_id);
});

test("merged venues redirect and export", async () => {
	const { registry } = await openMemoryRegistry();
	const a = registry.createVenue("Sands Theatre");
	const b = registry.createVenue("Sands Theatre MBS");
	registry.mergeVenue(b.id, a.id);
	assert.equal(registry.canonicalVenueId(b.id), a.id);
	const exported = registry.exportPublicVenues();
	assert.equal(exported.venues.length, 1);
	assert.deepEqual(exported.redirects, { [b.id]: a.id });
	assert.throws(() => registry.mergeVenue(a.id, b.id), /Cannot merge/);
});

test("locateRegistryVenues only locates unknown venues and fills from the registry", async () => {
	const { registry } = await openMemoryRegistry();
	const known = registry.createVenue("Funan");
	registry.setVenueLocation(known.id, {
		approximate_region: "Central",
		approximate_gps: { lat: 1.29, lng: 103.85 },
		approximate_nearest_mrt: "City Hall (EW13/NS25)",
		google_maps_url: "https://maps.example/funan",
	});
	const events = [
		{ title: "A", locations: [{ name: "Funan Mall", venue_id: known.id, venue_name: "Funan" }] },
		{ title: "B", locations: [{ name: "Online", venue_id: null, venue_name: null }] },
	];
	const calls = await locateRegistryVenues(events, registry);
	assert.equal(calls, 0, "no LLM call needed");
	assert.equal(events[0].locations[0].name, "Funan Mall");
	assert.equal(events[0].locations[0].approximate_region, "Central");
	assert.equal(events[0].locations[0].venue_id, known.id);
	assert.equal(events[1].locations[0].venue_id, null);
	assert.equal(events[1].locations[0].approximate_gps, null);
});

test("events keep their ID when details change, and reuse date ranges safely", async () => {
	const executor = await createSqliteExecutor(":memory:");
	const run1 = (await openMemoryRegistry("2026-11-10", executor)).registry;
	const venue = run1.createVenue("Esplanade");
	const first = run1.upsertEvent({
		title: "Mosaic Music Series 2026",
		description: "Old description",
		datetime: "1 Nov 2026 - 30 Nov 2026",
		daterange: ["01 Nov 2026", "30 Nov 2026"],
		category: ["Music"],
		locations: [{ venue_id: venue.id }],
		thumbnail: "abc.png",
	});
	run1.setThumbnailKeys((filename) => `archive-20261110-013300/${filename}`, new Set(["abc.png"]));
	await run1.commit();

	const run2 = (await openMemoryRegistry("2026-11-14", executor)).registry;
	const updated = {
		title: "Mosaic Music Series",
		description: "New description with more acts",
		datetime: "1 Nov 2026 - 30 Nov 2026",
		locations: [{ venue_id: venue.id }],
	};
	const brandNew = { title: "Totally Different Show", locations: [{ venue_id: venue.id }] };
	const matches = await matchEventsToRegistry([updated, brandNew], run2, { llm: failingLlm });
	assert.equal(matches.get(updated)?.id, first.id);
	assert.equal(matches.has(brandNew), false);

	const stored = matches.get(updated);
	assert.deepEqual(reusableDateRange(updated, stored), ["01 Nov 2026", "30 Nov 2026"]);
	assert.equal(reusableDateRange({ datetime: "Every Saturday" }, { ...stored, datetime: "Every Saturday" }), null);
	assert.equal(stored.thumbnailKey, "archive-20261110-013300/abc.png");

	const record = run2.upsertEvent({ ...updated, daterange: stored.daterange }, stored.id);
	assert.equal(record.id, first.id);
	assert.equal(record.firstSeen, "2026-11-10");
	assert.equal(record.seenCount, 2);
	assert.equal(record.description, "New description with more acts");
	assert.equal(record.thumbnail, "abc.png", "thumbnail carried over");
});

test("ambiguous events go to the LLM and one stored event is claimed once", async () => {
	const { registry } = await openMemoryRegistry();
	const esplanade = registry.createVenue("Esplanade");
	const gallery = registry.createVenue("National Gallery");
	const stored = registry.upsertEvent({ title: "Christmas Market", datetime: "14 Nov 2026", locations: [{ venue_id: esplanade.id }] });

	const elsewhere = { title: "Christmas Market", locations: [{ venue_id: gallery.id }] };
	let askedKeys = [];
	const llm = (prompt) => {
		const { events } = JSON.parse(prompt);
		askedKeys = events.map((event) => event.key);
		return Promise.resolve({ parsedJson: { matches: events.map((event) => ({ key: event.key, event_id: null })) } });
	};
	const matches = await matchEventsToRegistry([elsewhere], registry, { llm });
	assert.equal(askedKeys.length, 1, "same title at a different venue is asked, not auto-matched");
	assert.equal(matches.size, 0);

	const twinA = { title: "Christmas Market", datetime: "14 Nov 2026", locations: [{ venue_id: esplanade.id }] };
	const twinB = { title: "Christmas Market", datetime: "14 Nov 2026", locations: [{ venue_id: esplanade.id }] };
	const twinMatches = await matchEventsToRegistry([twinA, twinB], registry, { llm });
	assert.equal(twinMatches.size, 1);
	assert.equal([...twinMatches.values()][0].id, stored.id);
});


test("branch qualifiers remain distinct with model matching and deterministic fallback", async () => {
	for (const llm of [fakeVenueLlm, failingLlm]) {
		const { registry } = await openMemoryRegistry();
		const events = [
			{ locations: [{ name: "Wildseed Café (Alkaff Mansion)" }] },
			{ locations: [{ name: "Wildseed Café (The Summerhouse)" }] },
		];
		await resolveVenuesForEvents(events, registry, { llm });
		assert.equal(normalizeVenueName(events[0].locations[0].name), "wildseed cafe alkaff mansion");
		assert.notEqual(events[0].locations[0].venue_id, events[1].locations[0].venue_id);
		assert.match(events[0].locations[0].venue_name, /Alkaff Mansion/);
		assert.match(events[1].locations[0].venue_name, /Summerhouse/);
	}
});

test("only identical title, shared venue and unchanged explicit datetime skip model matching", async () => {
	const { registry } = await openMemoryRegistry();
	const venue = registry.createVenue("Esplanade");
	const stored = registry.upsertEvent({
		title: "Jazz Night", datetime: "14 Nov 2026", description: "An intimate jazz concert",
		daterange: ["14 Nov 2026", "14 Nov 2026"], locations: [{ venue_id: venue.id }],
	});
	const variants = [
		{ title: "Jazz Night", datetime: "14 Nov 2026", auto: true },
		{ title: "Jazz Night: Tribute to Miles Davis", datetime: "14 Nov 2026" },
		{ title: "Jazz Night", datetime: "28 Nov 2026" },
		{ title: "Jazz Night", datetime: "" },
		{ title: "Jazz Night", datetime: "14 Nov 2026", noVenue: true },
	];
	for (const variant of variants) {
		const event = { ...variant, description: "Current concert description",
			locations: variant.noVenue ? [] : [{ venue_id: venue.id }] };
		let calls = 0;
		const llm = async (prompt) => {
			calls++;
			const [input] = JSON.parse(prompt).events;
			assert.equal(input.description, event.description);
			assert.equal(input.candidates[0].description, stored.description);
			assert.deepEqual(input.candidates[0].daterange, stored.daterange);
			return { parsedJson: { matches: [{ key: input.key, event_id: null }] } };
		};
		const matches = await matchEventsToRegistry([event], registry, { llm });
		assert.equal(calls, variant.auto ? 0 : 1, JSON.stringify(variant));
		assert.equal(matches.get(event)?.id ?? null, variant.auto ? stored.id : null);
	}
});

test("unchanged relative dates do not automatically reuse a previous session", async () => {
	const { registry } = await openMemoryRegistry();
	const venue = registry.createVenue("Esplanade");
	registry.upsertEvent({ title: "Jazz Night", datetime: "This weekend",
		locations: [{ venue_id: venue.id }] });
	const event = { title: "Jazz Night", datetime: "This weekend", locations: [{ venue_id: venue.id }] };
	let asked = false;
	const matches = await matchEventsToRegistry([event], registry, { llm: async (prompt) => {
		asked = true;
		return { parsedJson: { matches: [{ key: JSON.parse(prompt).events[0].key, event_id: null }] } };
	} });
	assert.equal(asked, true);
	assert.equal(matches.size, 0);
});

test("model may preserve renamed or rescheduled events, but unavailable matching keeps them new", async () => {
	const { registry } = await openMemoryRegistry();
	const venue = registry.createVenue("Esplanade");
	const stored = registry.upsertEvent({ title: "Jazz Night", datetime: "14 Nov 2026",
		locations: [{ venue_id: venue.id }] });
	for (const event of [
		{ title: "Jazz Night: Encore", datetime: "14 Nov 2026", locations: [{ venue_id: venue.id }] },
		{ title: "Jazz Night", datetime: "28 Nov 2026", locations: [{ venue_id: venue.id }] },
	]) {
		const acceptingLlm = async (prompt) => ({ parsedJson: { matches: [
			{ key: JSON.parse(prompt).events[0].key, event_id: stored.id },
		] } });
		assert.equal((await matchEventsToRegistry([event], registry, { llm: acceptingLlm })).get(event)?.id, stored.id);
		assert.equal((await matchEventsToRegistry([event], registry, { llm: failingLlm })).size, 0);
	}
});
