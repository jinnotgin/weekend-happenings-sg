import test from "node:test";
import assert from "node:assert/strict";
process.env.GEMINI_API_KEY = "test-only";
const { generateJson } = await import("../lib/llm-gemini-rest.js");

test("Gemini uses its own default model and excludes thought parts from JSON", async t => {
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.match(url, /gemini-3.8-flash:generateContent$/);
        assert(!url.includes("key="));
        assert.equal(options.headers["x-goog-api-key"], "test-only");
        assert.equal(JSON.parse(options.body).generationConfig.thinkingConfig.thinkingLevel, "minimal");
        return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "reasoning" }, { text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 20 } });
    });
    assert.equal(await generateJson("source"), '{"ok":true}');
});

test("Gemini truncated output cannot pass as a successful JSON generation", async t => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"events":[]}' }] } }] }));
    await assert.rejects(generateJson("source"), /incomplete/);
});
