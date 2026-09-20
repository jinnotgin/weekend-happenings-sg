import test from "node:test";
import assert from "node:assert/strict";
import { braveSearch, getSearchResultsUrls, getWebLinkAndSaveImage, rankEventResults, resetSearchCache } from "../lib/brave-search.js";
import { enrichLocations, emptyLocation, validateLocation } from "../lib/location-enrichment.js";
import { fetchBytes } from "../lib/http.js";

function key(t) {
    const old = process.env.BRAVE_SEARCH_API_KEY; process.env.BRAVE_SEARCH_API_KEY = "test-only";
    t.after(() => { if (old === undefined) delete process.env.BRAVE_SEARCH_API_KEY; else process.env.BRAVE_SEARCH_API_KEY = old; });
    resetSearchCache();
}

test("Brave pagination, SG targeting, authorization and deduplication", async t => {
    key(t);
    const calls = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
        const u = new URL(url); calls.push(u);
        assert.equal(options.headers["X-Subscription-Token"], "test-only");
        assert.equal(u.searchParams.get("country"), "SG");
        const offset = Number(u.searchParams.get("offset"));
        return Response.json({ query: { more_results_available: offset === 0 }, web: { results: [{ url: "https://venue.sg/event" }, { url: `https://venue.sg/page${offset}` }] } });
    });
    const urls = await getSearchResultsUrls("Singapore events", 5);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].searchParams.get("offset"), "1");
    assert.equal(calls[0].searchParams.get("count"), "20");
    assert.equal(urls.length, 3);
    await getSearchResultsUrls("Singapore events", 5);
    assert.equal(calls.length, 2);
});

test("Brave auth errors propagate and failed calls are not cached", async t => {
    key(t);
    let count = 0;
    t.mock.method(globalThis, "fetch", async () => { count++; return new Response("unauthorized", { status: 401 }); });
    await assert.rejects(braveSearch("web", { q: "event" }), /401/);
    await assert.rejects(braveSearch("web", { q: "event" }), /401/);
    assert.equal(count, 2);
});

test("valid event link survives failed image search", async t => {
    key(t);
    t.mock.method(globalThis, "fetch", async url => {
        if (String(url).includes("/web/search")) return Response.json({ web: { results: [{ title: "Light Festival", url: "https://venue.sg/light", description: "Official Light Festival" }] } });
        if (String(url).includes("/images/search")) return new Response("unauthorized", { status: 401 });
        return new Response("<html><head></head><body>Light Festival</body></html>");
    });
    const result = await getWebLinkAndSaveImage('"Light Festival" Singapore', { title: "Light Festival" });
    assert.equal(result.firstWebUrl, "https://venue.sg/light");
    assert.deepEqual(result.savedImages, []);
});

test("ranking prefers matching event and venue over unrelated first result", () => {
    const ranked = rankEventResults([{ title: "Generic guide", url: "https://guide.sg", description: "Things to do" }, { title: "Light Festival 2026", url: "https://venue.sg", description: "Official event at Marina Bay" }], { title: "Light Festival", location: "Marina Bay", datetime: "2026" });
    assert.equal(ranked[0].url, "https://venue.sg");
});

test("Gemini-only location enrichment deduplicates venues and clears unsupported guesses", async () => {
    let searches = 0, generations = 0;
    const events = [{ locations: [{ name: "Esplanade", approximate_gps: { lat: 0, lng: 0 } }, { name: "Unknown venue" }] }, { locations: [{ name: "Esplanade" }] }];
    const result = await enrichLocations(events, {
        search: async name => { searches++; return name === "Esplanade" ? [{ url: "https://www.esplanade.com", description: "Singapore" }] : []; },
        generate: async (_, options) => {
            generations++;
            assert.deepEqual(options.preferenceOrder, [{ PROVIDER: "gemini", MODEL: "gemini-3.8-flash" }]);
            return { parsedJson: { location: { ...emptyLocation("wrong name"), approximate_region: "Central" } } };
        },
    });
    assert.equal(searches, 2); assert.equal(generations, 1);
    assert.equal(result[0].locations[0].name, "Esplanade");
    assert.equal(result[0].locations[0].approximate_gps, null);
    assert.match(result[0].locations[0].google_maps_url, /Esplanade%20Singapore/);
    assert.equal(result[0].locations[1].approximate_region, null);
    assert.throws(() => validateLocation({ approximate_gps: { lat: 0, lng: 0 } }));
});

test("HTTP body-size limit applies without a content-length header", async t => {
    t.mock.method(globalThis, "fetch", async () => new Response("123456"));
    await assert.rejects(fetchBytes("https://example.com", { maxBytes: 4 }), /download limit/);
});
