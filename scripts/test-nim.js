import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";

import { generateAndParseJson } from "#lib/llm-gateway.js";
import { NIM } from "#lib/constants.js";

const STRUCTURED_MODELS = [
	"stepfun-ai/step-3.5-flash",
	"moonshotai/kimi-k2-thinking",
	"z-ai/glm4.7",
	"meta/llama-4-maverick-17b-128e-instruct",
	"meta/llama-4-scout-17b-16e-instruct",
	"qwen/qwen3-235b-a22b",
	NIM.MODELS_SMART.DEEPSEEK_V3_2,
].filter(Boolean);

// FAILED MODELS
	// "minimaxai/minimax-m2.1",
	// "mistralai/mistral-large-3-675b-instruct-2512",
	// "mistralai/magistral-small-2506",
	// "google/gemma-3-27b-it"
	// "mistralai/ministral-14b-instruct-2512"

const SINGLE_MODEL = process.env.NIM_SINGLE_MODEL;
const MODELS_TO_TRY =
	typeof SINGLE_MODEL === "string" && SINGLE_MODEL.trim().length > 0
		? [SINGLE_MODEL.trim()]
		: Array.from(new Set([process.env.NIM_MODEL, ...STRUCTURED_MODELS].filter(Boolean)));

const HISTORY_PATH =
	process.env.NIM_TEST_HISTORY_PATH ??
	path.resolve(process.cwd(), "logs", "nim-structured-output-history.jsonl");

const responseSchema = {
	name: "NimSmokeTest",
	schema: {
		type: "object",
		additionalProperties: false,
		properties: {
			ok: { type: "boolean" },
			provider: { type: "string" },
			message: { type: "string" },
		},
		required: ["ok", "provider", "message"],
	},
};

const prompt =
	'Return JSON only with keys ok, provider, message. Set ok=true. Set provider="nim". Set message="NIM integration works."';

function fail(message, details) {
	console.error(`NIM test failed: ${message}`);
	if (details) {
		console.error(details);
	}
	process.exit(1);
}

function summarizeError(error) {
	const status = error?.status;
	const reqId = error?.headers?.["nvcf-reqid"];
	const message = error?.message ?? "Unknown error";
	return {
		status: status ?? null,
		reqId: reqId ?? null,
		message,
	};
}

async function readHistory() {
	try {
		const raw = await fs.readFile(HISTORY_PATH, "utf8");
		return raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch (error) {
		if (error?.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

async function appendHistory(records) {
	await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
	const lines = records.map((record) => JSON.stringify(record)).join("\n");
	await fs.appendFile(HISTORY_PATH, `${lines}\n`, "utf8");
}

function buildFailureSummary(historyRecords, models) {
	const index = new Map();

	for (const model of models) {
		index.set(model, {
			model,
			totalRuns: 0,
			passes: 0,
			failures: 0,
			lastFailureAt: null,
			lastFailureMessage: null,
			lastFailureStatus: null,
			lastFailureReqId: null,
		});
	}

	for (const record of historyRecords) {
		const model = record?.model;
		if (!model) continue;
		if (!index.has(model)) {
			index.set(model, {
				model,
				totalRuns: 0,
				passes: 0,
				failures: 0,
				lastFailureAt: null,
				lastFailureMessage: null,
				lastFailureStatus: null,
				lastFailureReqId: null,
			});
		}

		const row = index.get(model);
		row.totalRuns += 1;
		if (record.status === "pass") {
			row.passes += 1;
		} else {
			row.failures += 1;
			row.lastFailureAt = record.timestamp ?? row.lastFailureAt;
			row.lastFailureMessage = record.error?.message ?? row.lastFailureMessage;
			row.lastFailureStatus = record.error?.status ?? row.lastFailureStatus;
			row.lastFailureReqId = record.error?.reqId ?? row.lastFailureReqId;
		}
	}

	return Array.from(index.values()).sort((a, b) => b.failures - a.failures);
}

async function testModelStructuredOutput(model) {
	console.log(`Testing NIM via llm-gateway with model: ${model} (json_schema)`);

	const { parsedJson, rawJson } = await generateAndParseJson(prompt, {
		provider: "nim",
		model,
		preferenceOrder: [{ PROVIDER: "nim", MODEL: model }],
		responseSchema,
		temperature: 0,
	});

	if (!parsedJson || typeof parsedJson !== "object") {
		throw new Error(`No parsed JSON returned. Raw: ${String(rawJson).slice(0, 250)}`);
	}

	if (parsedJson.ok !== true) {
		throw new Error(
			`Response did not include ok=true. Parsed: ${JSON.stringify(parsedJson)}`
		);
	}

	return parsedJson;
}

async function main() {
	if (!process.env.NIM_API_KEY) {
		fail("NIM_API_KEY is missing from environment");
	}

	if (MODELS_TO_TRY.length === 0) {
		fail("No models configured to test");
	}

	const startedAt = new Date().toISOString();
	const runResults = [];
	let passCount = 0;

	for (const model of MODELS_TO_TRY) {
		try {
			const parsedJson = await testModelStructuredOutput(model);
			passCount += 1;
			runResults.push({
				timestamp: startedAt,
				model,
				mode: "json_schema",
				status: "pass",
				parsedJson,
			});
			console.log(`Scenario passed: ${model} (json_schema)`);
		} catch (error) {
			const summary = summarizeError(error);
			runResults.push({
				timestamp: startedAt,
				model,
				mode: "json_schema",
				status: "fail",
				error: summary,
			});
			console.error(`Scenario failed: ${model} (json_schema)`);
			console.error(
				`status=${summary.status ?? "unknown"} reqId=${summary.reqId ?? "n/a"} message=${summary.message}`
			);
		}
	}

	await appendHistory(runResults);
	const historyRecords = await readHistory();
	const failureSummary = buildFailureSummary(historyRecords, MODELS_TO_TRY);

	console.log("\nStructured output summary (historical):");
	console.log(JSON.stringify(failureSummary, null, 2));
	console.log(`\nHistory file: ${HISTORY_PATH}`);

	if (passCount === 0) {
		fail("All NIM structured-output scenarios failed for this run");
	}

	console.log(`\nRun complete: ${passCount}/${MODELS_TO_TRY.length} models passed.`);
}

await main();
