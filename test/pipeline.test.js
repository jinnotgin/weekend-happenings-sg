import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { main } from "../index.js";

const event = { title: "Light Festival", description: "Light art at the waterfront", datetime: "20 Sep 2026", locations: [{ name: "Esplanade" }] };
function services() {
    const usedTasks = [];
    let uploads = 0;
    return {
        usedTasks, get uploads() { return uploads; },
        getSearchResultsUrls: async () => ["https://venue.sg/festival"],
        scrapeUrlForTextTags: async url => ({ title: "Event page", data: `Content from ${url}` }),
        generateAndParseJson: async (_, options) => {
            usedTasks.push(options.task);
            let parsedJson;
            switch (options.task) {
                case "PARSE_EVENTS": parsedJson = { events: [structuredClone(event)] }; break;
                case "UNIQUE_EVENTS": parsedJson = { uniqueEvents: [{ title: event.title, description: event.description }] }; break;
                case "CONSOLIDATE_EVENTS": parsedJson = { events: [{ ...structuredClone(event), category: ["Arts & Culture"], source: [0, 1] }] }; break;
                case "DATE_RANGES": parsedJson = { dateRanges: [["20 Sep 2026", "20 Sep 2026"]] }; break;
                default: throw new Error(`Unexpected task ${options.task}`);
            }
            return { parsedJson, rawJson: JSON.stringify(parsedJson) };
        },
        enrichLocations: async events => { usedTasks.push("LOCATION_ENRICHMENT"); return events; },
        getWebLinkAndSaveImage: async query => { assert.equal(query, '"Light Festival" Singapore'); return { firstWebUrl: "https://venue.sg/festival", savedImages: [] }; },
        selectBestEventImage: async () => { throw new Error("Should not select nonexistent images"); },
        uploadAndUpdateLatest: async () => { uploads++; return true; },
    };
}
async function workingDir(t) {
    const original = process.cwd();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "events-pipeline-"));
    process.chdir(dir);
    t.after(async () => { process.chdir(original); await fs.rm(dir, { recursive: true, force: true }); });
    return dir;
}

test("fixture pipeline exercises every stage and dry-run never publishes", async t => {
    const dir = await workingDir(t);
    const mock = services();
    await main({ mode: "dry-run", services: mock });
    assert.equal(mock.uploads, 0);
    assert.deepEqual(mock.usedTasks, ["PARSE_EVENTS", "PARSE_EVENTS", "UNIQUE_EVENTS", "CONSOLIDATE_EVENTS", "LOCATION_ENRICHMENT", "DATE_RANGES"]);
    const output = JSON.parse(await fs.readFile(path.join(dir, "data/compiled/events.json")));
    assert.deepEqual(output[0].daterange, ["20 Sep 2026", "20 Sep 2026"]);
    assert.equal(output[0].link, "https://venue.sg/festival");
    assert.equal(output[0].thumbnail, null);
});

test("pipeline propagates upload failure to caller", async t => {
    await workingDir(t);
    const mock = services();
    mock.uploadAndUpdateLatest = async () => { throw new Error("R2 unavailable"); };
    await assert.rejects(main({ mode: "staging", services: mock }), /R2 unavailable/);
});
