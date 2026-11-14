import { test } from "node:test";
import assert from "node:assert/strict";
import { createSqliteExecutor } from "../lib/registry/executors.js";
import { Registry } from "../lib/registry/store.js";
import { reusableDateRange } from "../lib/registry/resolve-events.js";

test("failed enrichment after a reschedule invalidates the old date cache across runs", async () => {
	const executor = await createSqliteExecutor(":memory:");
	try {
		const firstRun = await Registry.open({ executor, today: "2026-11-10" });
		const original = firstRun.upsertEvent({
			title: "Jazz Night", datetime: "14 Nov 2026",
			daterange: ["14 Nov 2026", "14 Nov 2026"],
		});
		await firstRun.commit();

		const secondRun = await Registry.open({ executor, today: "2026-11-14" });
		const failed = secondRun.upsertEvent({
			title: "Jazz Night", datetime: "28 Nov 2026", daterange: "Error: Unable to process",
		}, original.id);
		assert.equal(failed.daterange, null);
		assert.equal(failed.dateStart, null);
		assert.equal(failed.dateEnd, null);
		await secondRun.commit();

		const thirdRun = await Registry.open({ executor, today: "2026-11-17" });
		const nextEvent = { title: "Jazz Night", datetime: "28 Nov 2026" };
		assert.equal(reusableDateRange(nextEvent, thirdRun.events.get(original.id)), null,
			"the following run must retry enrichment rather than reuse the old schedule");
		const recovered = thirdRun.upsertEvent({
			...nextEvent, daterange: ["28 Nov 2026", "28 Nov 2026"],
		}, original.id);
		assert.equal(recovered.id, original.id);
		assert.equal(recovered.firstSeen, original.firstSeen);
		assert.equal(recovered.dateStart, "2026-11-28");
		assert.deepEqual(reusableDateRange(nextEvent, recovered), ["28 Nov 2026", "28 Nov 2026"]);
	} finally {
		executor.close();
	}
});

test("an unchanged schedule may retain its last successful date enrichment", async () => {
	const executor = await createSqliteExecutor(":memory:");
	try {
		const registry = await Registry.open({ executor, today: "2026-11-14" });
		const first = registry.upsertEvent({
			title: "Jazz Night", datetime: "28 Nov 2026",
			daterange: ["28 Nov 2026", "28 Nov 2026"],
		});
		const updated = registry.upsertEvent({
			title: "Jazz Night", datetime: " 28 Nov 2026 ", daterange: "Error: Unable to process",
		}, first.id);
		assert.deepEqual(updated.daterange, first.daterange);
		assert.equal(updated.dateEnd, "2026-11-28");
		const unknown = registry.upsertEvent({ title: "Jazz Night", datetime: null }, first.id);
		assert.equal(unknown.daterange, null);
	} finally {
		executor.close();
	}
});
