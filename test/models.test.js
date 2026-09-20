import test from "node:test";
import assert from "node:assert/strict";
import { buildChatRequest, generateChatJson } from "../lib/llm-chat.js";
import { generateAndParseJson } from "../lib/llm-gateway.js";
import { LLM_TASK_PREFERENCES as tasks } from "../lib/constants.js";
import { validateDateRange } from "../lib/validation.js";
import { PARSED_EVENTS_RESPONSE_SCHEMA } from "../lib/schemas/parsed-events.js";

const schema = { name: "ParsedEvents", schema: PARSED_EVENTS_RESPONSE_SCHEMA };
const completion = content => Response.json({ choices: [{ finish_reason: "stop", message: { content } }], usage: { total_tokens: 20 } });

test("extraction and dedupe try both free routes before Luna; consolidation uses Luna", () => {
    for (const task of [tasks.PARSE_EVENTS, tasks.UNIQUE_EVENTS]) {
        assert.deepEqual(task.ORDERED.map(p => p.PROVIDER), ["openrouter", "nim", "openai", "openrouter", "gemini"]);
        assert.match(task.ORDERED[0].MODEL, /gemma-4.*:free$/);
        assert.equal(task.ORDERED[2].MODEL, "gpt-5.6-luna");
    }
    assert.equal(tasks.CONSOLIDATE_EVENTS.PRIMARY.MODEL, "gpt-5.6-luna");
    assert.deepEqual(tasks.LOCATION_ENRICHMENT.ORDERED, [{ PROVIDER: "gemini", MODEL: "gemini-3.8-flash" }]);
    assert.equal(tasks.IMAGE_SELECTION.ORDERED.some(p => p.PROVIDER === "openai"), false);
});

test("provider-specific JSON, reasoning, and token parameters", () => {
    const options = { responseSchema: schema, maxOutputTokens: 2048 };
    const free = buildChatRequest("openrouter", "extract", options);
    assert.deepEqual(free.response_format, { type: "json_object" });
    assert.match(free.messages[0].content, /additionalProperties/);
    assert.equal(free.reasoning.enabled, false);
    const nim = buildChatRequest("nim", "extract", options);
    assert.equal(nim.response_format, undefined);
    assert.equal(nim.messages[0].role, "user");
    assert.equal(nim.chat_template_kwargs.enable_thinking, false);
    const luna = buildChatRequest("openai", "extract", options);
    assert.equal(luna.response_format.json_schema.strict, true);
    assert.equal(luna.reasoning_effort, "none");
    assert.equal(luna.max_completion_tokens, 2048);
    assert.equal(luna.temperature, undefined);
    assert.equal(luna.frequency_penalty, undefined);
});

test("malformed shape and invalid JSON advance through free routes to Luna", async t => {
    t.mock.method(globalThis, "fetch", async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push(body.model);
        if (calls.length === 1) return completion('{"wrong":[]}');
        if (calls.length === 2) return completion('broken JSON');
        return completion('{"events":[]}');
    });
    const calls = [];
    for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "NIM_API_KEY"]) {
        const old = process.env[key]; process.env[key] = "test-only";
        t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    }
    const result = await generateAndParseJson("source", { responseSchema: schema, preferenceOrder: tasks.PARSE_EVENTS.ORDERED });
    assert.deepEqual(result.parsedJson, { events: [] });
    assert.deepEqual(calls, ["google/gemma-4-31b-it:free", "google/gemma-4-31b-it", "gpt-5.6-luna"]);
});

test("incomplete model output fails without recursive continuation", async t => {
    const old = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test-only";
    t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; });
    let count = 0;
    t.mock.method(globalThis, "fetch", async () => { count++; return Response.json({ choices: [{ finish_reason: "length", message: { content: '{"events":[]}' } }] }); });
    await assert.rejects(generateChatJson("openai", "source", { responseSchema: schema }), /incomplete/);
    assert.equal(count, 1);
});

test("dates reject impossible, reversed and arbitrary text values", () => {
    assert.deepEqual(validateDateRange([null, null]), [null, null]);
    validateDateRange(["29 Feb 2024", "01 Mar 2024"]);
    for (const range of [["29 Feb 2025", null], ["31 Apr 2026", null], ["02 Jan 2026", "01 Jan 2026"], ["tomorrow", null]]) {
        assert.throws(() => validateDateRange(range));
    }
});

 test("dedupe and consolidation enable reasoning on every chat fallback", () => {
    for (const task of ["UNIQUE_EVENTS", "CONSOLIDATE_EVENTS"]) {
        for (const { PROVIDER: provider, MODEL: model } of tasks[task].ORDERED) {
            if (provider === "gemini") continue;
            const request = buildChatRequest(provider, "events", { task, model });
            if (provider === "openai") assert.equal(request.reasoning_effort, "medium");
            else if (provider === "nim") assert.equal(request.chat_template_kwargs.enable_thinking, true);
            else if (model.includes("gpt-oss")) assert.equal(request.reasoning.effort, "medium");
            else assert.equal(request.reasoning.enabled, true);
            assert.equal(request.max_completion_tokens ?? request.max_tokens, 16384);
        }
    }
    for (const task of ["PARSE_EVENTS", "DATE_RANGES", "IMAGE_SELECTION"]) {
        assert.equal(buildChatRequest("openai", "events", { task }).reasoning_effort, "none");
        assert.equal(buildChatRequest("nim", "events", { task }).chat_template_kwargs.enable_thinking, false);
        assert.equal(buildChatRequest("openrouter", "events", { task }).reasoning.enabled, false);
    }
});
