import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "../lib/registry/store.js";
import { createSqliteExecutor } from "../lib/registry/executors.js";
import { resolveVenuesForEvents } from "../lib/registry/resolve-venues.js";
import { normalizeVenueName } from "../lib/registry/normalize.js";

const eventAt = (name) => ({ title: "Weekend event", locations: [{ name }] });
const idOf = (event) => event.locations[0].venue_id;
const unavailable = async () => { throw new Error("Model unavailable"); };
const separateBranches = async (prompt) => ({ parsedJson: { groups:
	JSON.parse(prompt).names.map(({ key }) => ({ keys: [key], match_venue_id: null,
		canonical_name: "Starbucks", is_place: true })),
} });

for (const [label, llm] of [["model", separateBranches], ["fallback", unavailable]]) {
	test(`street addresses distinguish chain branches across runs with ${label}`, async () => {
		const executor = await createSqliteExecutor(":memory:");
		try {
			const first = await Registry.open({ executor, today: "2026-11-14" });
			const names = ["Starbucks, 1 Orchard Road", "Starbucks, 2 Orchard Road"];
			const events = names.map(eventAt);
			await resolveVenuesForEvents(events, first, { llm });
			assert.notEqual(idOf(events[0]), idOf(events[1]));
			assert.equal(first.findVenueByName("Starbucks"), null, "no unsafe generic alias is invented");
			assert.notEqual(normalizeVenueName(names[0]), normalizeVenueName(names[1]));
			await first.commit();
			const second = await Registry.open({ executor, today: "2026-11-15" });
			const repeated = names.map(eventAt);
			await resolveVenuesForEvents(repeated, second, { llm: async () => assert.fail("exact qualified aliases need no model") });
			assert.deepEqual(repeated.map(idOf), events.map(idOf));
			const thirdBranch = eventAt("Starbucks, 3 Orchard Road");
			await resolveVenuesForEvents([thirdBranch], second, { llm });
			assert.ok(!events.map(idOf).includes(idOf(thirdBranch)));
			assert.equal(second.findVenueByName("Starbucks"), null);
		} finally { executor.close(); }
	});
}

test("address-qualified inputs do not exactly match a preexisting generic alias", async () => {
	const executor = await createSqliteExecutor(":memory:");
	try {
		const first = await Registry.open({ executor, today: "2026-11-14" });
		const legacy = first.createVenue("Starbucks");
		await first.commit();
		const registry = await Registry.open({ executor, today: "2026-11-15" });
		const event = eventAt("Starbucks, 2 Orchard Road");
		let calls = 0;
		await resolveVenuesForEvents([event], registry, { llm: async (prompt) => {
			calls++;
			assert.equal(JSON.parse(prompt).names[0].candidates[0].id, legacy.id);
			return separateBranches(prompt);
		} });
		assert.equal(calls, 1);
		assert.notEqual(idOf(event), legacy.id, "new-place model decision beats generic canonical-name collision");
		const another = eventAt("Starbucks, 3 Orchard Road");
		await resolveVenuesForEvents([another], registry, { llm: unavailable });
		assert.notEqual(idOf(another), legacy.id);
		assert.notEqual(idOf(another), idOf(event));
	} finally { executor.close(); }
});

test("ordinary address and bare-name variants can share a stable ID through model matching", async () => {
	const executor = await createSqliteExecutor(":memory:");
	try {
		const first = await Registry.open({ executor, today: "2026-11-14" });
		const venue = first.createVenue("Asian Civilisations Museum, 1 Empress Place");
		await first.commit();
		const second = await Registry.open({ executor, today: "2026-11-15" });
		const events = [eventAt("Asian Civilisations Museum"), eventAt("Asian Civilisations Museum, 1 Empress Place, #01-01")];
		await resolveVenuesForEvents(events, second, { llm: async (prompt) => {
			const { names } = JSON.parse(prompt);
			assert.equal(names.length, 2, "neither variant is collapsed before the model");
			for (const item of names) {
				assert.equal(item.candidates[0].id, venue.id);
				assert.ok(item.candidates[0].aliases.includes("asian civilisations museum 1 empress place"));
			}
			return { parsedJson: { groups: [{ keys: names.map(({ key }) => key),
				match_venue_id: venue.id, canonical_name: null, is_place: true }] } };
		} });
		assert.deepEqual(events.map(idOf), [venue.id, venue.id]);
		await second.commit();
		const third = await Registry.open({ executor, today: "2026-11-16" });
		const repeated = eventAt("Asian Civilisations Museum");
		await resolveVenuesForEvents([repeated], third, { llm: async () => assert.fail("accepted alias persists") });
		assert.equal(idOf(repeated), venue.id);
	} finally { executor.close(); }
});
