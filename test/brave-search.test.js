import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { getSearchResultsUrls, getWebLinkAndSaveImage } from "../lib/brave-search.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=", "base64");
const json = (body) => Response.json(body);
const web = (results, more = false) => json({ web: { results }, query: { more_results_available: more } });
const image = () => new Response(png, { headers: { "content-type": "image/png" } });

function cleanImages(t, result) {
	t.after(async () => {
		for (const dir of new Set(result.savedImages.map((item) => path.dirname(item.absolutePath)))) {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
}

test("discovery authenticates in headers, localizes, paginates and deduplicates", async (t) => {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (input, options) => {
		const url = new URL(input);
		calls.push({ url, options, at: Date.now() });
		return calls.length === 1
			? web([{ url: "https://events.sg/a" }, { url: "javascript:bad" }], true)
			: web([{ url: "https://events.sg/a" }, { url: "https://events.sg/b" }]);
	});
	assert.deepEqual(await getSearchResultsUrls("things to do singapore", 2), ["https://events.sg/a", "https://events.sg/b"]);
	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map(({ url }) => url.searchParams.get("offset")), ["0", "1"]);
	assert.ok(calls[1].at - calls[0].at >= 1000, "requests should respect the subscription rate limit");
	for (const { url, options } of calls) {
		assert.equal(url.origin, "https://api.search.brave.com");
		assert.equal(url.pathname, "/res/v1/web/search");
		assert.equal(url.searchParams.get("country"), "SG");
		assert.equal(url.searchParams.get("search_lang"), "en");
		assert.equal(url.searchParams.get("safesearch"), "strict");
		assert.equal(url.searchParams.get("count"), "10");
		assert.equal(url.searchParams.get("result_filter"), "web");
		assert.equal(url.searchParams.has("key"), false);
		assert.equal(options.headers["X-Subscription-Token"], process.env.BRAVE_SEARCH_API_KEY);
		assert.ok(options.signal instanceof AbortSignal);
	}
});

test("discovery stops when Brave reports no further pages", async (t) => {
	const fetch = t.mock.method(globalThis, "fetch", async () => web([]));
	assert.deepEqual(await getSearchResultsUrls("empty", 2), []);
	assert.equal(fetch.mock.callCount(), 1);
});

test("concurrent discovery is paced and a failed request does not poison the queue", async (t) => {
	const times = [];
	t.mock.method(globalThis, "fetch", async () => {
		times.push(Date.now());
		return times.length === 1 ? new Response("unavailable", { status: 429 }) : web([{ url: "https://events.sg/ok" }]);
	});
	const results = await Promise.allSettled([getSearchResultsUrls("first"), getSearchResultsUrls("second")]);
	assert.equal(results[0].status, "rejected");
	assert.match(results[0].reason.message, /Brave web search returned HTTP 429/);
	assert.deepEqual(results[1].value, ["https://events.sg/ok"]);
	assert.ok(times[1] - times[0] >= 1000);
});

test("usable web thumbnail avoids image search and retains source-page provenance", async (t) => {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (input, options) => {
		const url = new URL(input);
		calls.push(url.href);
		if (url.hostname === "api.search.brave.com") {
			return web([{ url: "https://events.sg/event", thumbnail: { original: "https://images.sg/original.png", src: "https://images.sg/small.png" } }]);
		}
		assert.equal(options.headers, undefined, "subscription token must not be sent to image hosts");
		return image();
	});
	const result = await getWebLinkAndSaveImage("event singapore", { maxImages: 1 });
	cleanImages(t, result);
	assert.equal(result.firstWebUrl, "https://events.sg/event");
	assert.equal(result.savedImages.length, 1);
	assert.equal(result.savedImages[0].sourceUrl, "https://images.sg/original.png");
	assert.equal(result.savedImages[0].pageUrl, "https://events.sg/event");
	assert.equal(calls.length, 2);
	assert.deepEqual(await fs.readFile(result.savedImages[0].absolutePath), png);
});

test("failed web images fall back to original image-search assets, skipping logos and duplicates", async (t) => {
	const calls = [];
	t.mock.method(globalThis, "fetch", async (input) => {
		const url = new URL(input);
		calls.push(url.href);
		if (url.pathname === "/res/v1/web/search") return web([
			{ url: "https://events.sg/event", thumbnail: { original: "https://images.sg/broken.png" } },
			{ url: "https://events.sg/duplicate", thumbnail: { original: "https://images.sg/broken.png" } },
			{ url: "https://events.sg/logo", thumbnail: { original: "https://images.sg/logo.png", logo: true } },
		]);
		if (url.pathname === "/res/v1/images/search") {
			assert.equal(url.searchParams.get("country"), "SG");
			assert.equal(url.searchParams.get("spellcheck"), "false");
			return json({ results: [
				{ url: "https://events.sg/event", properties: { url: "https://images.sg/broken.png" } },
				{ url: "https://events.sg/event", properties: { url: "https://images.sg/poster.png" } },
			] });
		}
		return url.pathname === "/broken.png" ? new Response("blocked", { status: 403 }) : image();
	});
	const result = await getWebLinkAndSaveImage("event singapore", { maxImages: 1 });
	cleanImages(t, result);
	assert.equal(result.firstWebUrl, "https://events.sg/event");
	assert.equal(result.savedImages[0].sourceUrl, "https://images.sg/poster.png");
	assert.equal(calls.filter((url) => url === "https://images.sg/broken.png").length, 1);
	assert.ok(!calls.includes("https://images.sg/logo.png"));
});

test("an empty image search preserves the event link without throwing", async (t) => {
	t.mock.method(globalThis, "fetch", async (input) => new URL(input).pathname === "/res/v1/web/search"
		? web([{ url: "https://events.sg/event" }]) : json({ results: [] }));
	assert.deepEqual(await getWebLinkAndSaveImage("no pictures"), { firstWebUrl: "https://events.sg/event", savedImages: [] });
});

test("image-search outages retain usable web images", async (t) => {
	t.mock.method(globalThis, "fetch", async (input) => {
		const url = new URL(input);
		if (url.pathname === "/res/v1/web/search") return web([{ url: "https://events.sg/event", thumbnail: { src: "https://images.sg/poster.png" } }]);
		if (url.pathname === "/res/v1/images/search") return new Response("unavailable", { status: 503 });
		return image();
	});
	const result = await getWebLinkAndSaveImage("event singapore", { maxImages: 2 });
	cleanImages(t, result);
	assert.equal(result.firstWebUrl, "https://events.sg/event");
	assert.equal(result.savedImages.length, 1);
});

test("malformed search responses fail rather than silently publishing empty results", async (t) => {
	t.mock.method(globalThis, "fetch", async () => json({ web: { results: {} } }));
	await assert.rejects(getSearchResultsUrls("event"), /invalid results/);
});

test("image-search failure preserves a valid link even without a thumbnail", async (t) => {
	t.mock.method(globalThis, "fetch", async (input) => new URL(input).pathname === "/res/v1/web/search"
		? web([{ url: "https://events.sg/event" }]) : new Response("unavailable", { status: 503 }));
	assert.deepEqual(await getWebLinkAndSaveImage("no pictures"), { firstWebUrl: "https://events.sg/event", savedImages: [] });
});
