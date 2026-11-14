import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXED_URLS_TO_SCRAPE = [
	"https://www.esplanade.com/sitecore/api/website/event/listing/view-by-event?languages=en&pageSize=20&pageNumber=1&parentId=42857e7088b6423aad796cff9cde96f1&datasourceId=d24311e43b38443ca4f83bcdc41727fb&eventType=ongoing",  // Esplanade Beautiful Sunday
];
export const SCRAPER_OPTIONS = {
	PERFORM_WEB_SEARCH: process.env.PERFORM_WEB_SEARCH !== "false",
};
export const SEARCH_TERM_FOR_EVENTS = "things to do singapore";
export const BLACKLISTED_DOMAINS = [
	"https://www.eventbrite.sg/",
	"https://nowinsg.com/",
	"https://thetravelintern.com/",
];

export const RETRY_COUNT = 3;

/*
 * ============================================================================
 * MODEL SELECTION RATIONALE (snapshot 2026-11-14)
 * ============================================================================
 * Written so a future maintainer (human or AI) can re-judge these choices as
 * prices, quotas and models change. Re-verify every number before relying on it.
 *
 * Principles
 * - Default to cheap PAID OpenRouter models: predictable, no daily caps, ~$0.05-0.10/run.
 * - Use FREE Google AI Studio models only where the per-run call volume fits the
 *   free per-project quotas (RPM/RPD). Free-tier prompts may be used by Google to
 *   improve products; free tier has no Google Search/Maps grounding.
 * - Match model strength to the task: judgment (dedupe/merge) -> strongest model;
 *   knowledge (venue location) -> cheap Google models; high-volume extraction -> the
 *   most token-efficient cheap model.
 * - Never let a low-priority task (image selection) consume a scarce free pool that a
 *   higher-priority task falls back to (3.5 Flash-Lite).
 *
 * Snapshot (sources: openrouter.ai model pages + GET /api/v1/models,
 * aistudio.google.com/docs/pricing, AI Studio rate-limit console,
 * flaviocopes.com/small-ai-models, Artificial Analysis (AA) Intelligence Index)
 * - GPT-6 Luna (openai/gpt-6-luna): $0.10/M in, $0.50/M out, cached in $0.01; above
 *   272K input $0.20/$0.75. ~1.05M ctx. AA 21.5 (low effort) .. 38.1 (max). Reasoning
 *   can be off ("none"). Vision: yes. Ignores/rejects temperature (not in supported_parameters).
 *   Cheapest in practice: 200-post JSON-enum tagging test (flaviocopes) 79% with
 *   reasoning off at $0.0078 vs Haiku $0.017 (Haiku tokenizer counts ~2x input) and Ember $0.034.
 * - Claude Haiku 5.5 (anthropic/claude-haiku-5.5): $0.10/$0.50 up to 100K input tokens,
 *   $0.50/$2.50 above (watch long consolidation prompts). 1M ctx. AA 43.4, highest of the
 *   cheap tier -> best judgment. Vision: yes. Rejects non-default sampling params.
 * - Gemini 3.5 Flash-Lite: AI Studio FREE 15 RPM / 250K TPM / 500 RPD per project;
 *   paid via OpenRouter (google/gemini-3.5-flash-lite) $0.30/$2.50, reasoning mandatory
 *   (default "minimal"). AA ~36.5. Native vision.
 * - Gemini 3.1 Flash-Lite: AI Studio FREE 15 RPM / 250K TPM / 500 RPD (separate pool from 3.5).
 * - Gemini 4 Hydrogen (released 2026-11-12): AI Studio FREE 5 RPM / 250K TPM / 20 RPD;
 *   paid $1.50/$7.50. Strongest free Google model. Default thinking "high"
 *   (levels low/medium/high/xhigh; no "minimal").
 * - Free limits are per Google Cloud PROJECT, not per key; RPD resets midnight Pacific.
 *   GEMINI_API_KEYS rotation only adds capacity if keys are in different projects (and
 *   Google's terms may restrict splitting projects to evade limits).
 *
 * Rejected
 * - Muse Ember (meta/muse-ember, $0.10/$0.50): reasoning mandatory (400 if disabled), ~23x
 *   more output tokens on short tasks -> more expensive than Luna/Haiku in practice.
 * - Gemini 2.5 Pro, 3.1 Pro, 4 Argon, 4 Carbon: free limit 0.
 * - Gemini 2.5 Flash / 2.5 Flash-Lite / 3 Flash / 3.6 Flash / 3.8 Flash: only 5-10 RPM,
 *   20 RPD free. gemini-2.5-flash is deprecated (reroutes to 3.5 Flash-Lite from
 *   2026-12-01); gemini-3-flash-preview is legacy.
 * - Hydrogen for location guessing: 20 RPD can't cover one-call-per-event, and location
 *   is knowledge-heavy/low-judgment, so Flash-Lite is the better fit.
 * - Qwen, Gemma 3, gpt-oss, Mistral, NVIDIA NIM: dropped by owner decision in favour of
 *   the cheap paid tier above (NIM client archived in lib/archived/). Direct OpenAI is
 *   no longer in any preference list (lib/llm-openai.js kept but unused).
 *
 * Google-location theory (UNPROVEN): Google models may know Singapore venues better
 * (Maps-derived training data), so LOCATE_VENUES tries Gemini first. Suggested check:
 * A/B the same events through Gemini vs Haiku and compare region/MRT/GPS accuracy.
 *
 * How to re-evaluate
 * 1. Prices incl. long-context tiers (OpenRouter `pricing.overrides`), batch variants.
 * 2. Token efficiency, not list price: tokenizer inflation, reasoning-token output.
 * 3. Mandatory reasoning (OpenRouter `reasoning.mandatory`) and supported efforts.
 * 4. Free-tier RPM/RPD per project vs per-run call counts below.
 * 5. Vision support (`architecture.input_modalities`) for IMAGE_SELECTION.
 * 6. Structured-output support (`supported_parameters` has structured_outputs/response_format).
 * 7. Deprecations / renamed IDs (GET .../v1beta/models, OpenRouter /api/v1/models).
 * ============================================================================
 */

// Gemini direct (AI Studio REST) model IDs, confirmed via GET /v1beta/models on 2026-11-14.
export const GEMINI = {
	MODELS: {
		GEMINI_4_HYDROGEN: "gemini-4-hydrogen",
		GEMINI_3_5_FLASH_LITE: "gemini-3.5-flash-lite",
		GEMINI_3_1_FLASH_LITE: "gemini-3.1-flash-lite",
	},
	DEFAULT_MODEL: "gemini-3.5-flash-lite",
};

// Legacy Vertex configuration retained for archived helpers.
export const VERTEX = {
	LOCATION: "us-central1",
	PUBLISHER: "google",
	MODEL: "text-bison-32k",
};

// Direct OpenAI client (lib/llm-openai.js) is kept but not used by any preference list.
export const OPENAI = {
	MODEL_GPT5_MINI: "gpt-5-mini",
	MODEL_GPT5_NANO: "gpt-5-nano",
};

// OpenRouter model IDs, confirmed via GET https://openrouter.ai/api/v1/models on 2026-11-14.
// All three accept image input and structured outputs (response_format json_schema).
export const OPENROUTER = {
	MODELS: {
		GPT_6_LUNA: "openai/gpt-6-luna",
		CLAUDE_HAIKU_5_5: "anthropic/claude-haiku-5.5",
		GEMINI_3_5_FLASH_LITE: "google/gemini-3.5-flash-lite",
	},
	DEFAULT_MODEL: "openai/gpt-6-luna",
};

export const IMAGE_SELECTION_CONFIG = {
	MAX_IMAGE_CANDIDATES: 6,
	MAX_INLINE_IMAGE_BYTES: 20 * 1024 * 1024, // Gemini inline_data limit
	// Optional per-provider caps, e.g. { openrouter: 5 }.
	MAX_IMAGE_CANDIDATES_BY_PROVIDER: {},
};

// Pacing between LOCATE_VENUES calls: 15 RPM free tier => calls >= 4s apart.
export const LOCATE_VENUES_CALL_DELAY_MS = 4000;

/*
 * Preference entries: { PROVIDER, MODEL, OPTIONS? }
 * OPTIONS.REASONING_EFFORT: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
 * - openrouter -> request `reasoning: { effort }` ("none" disables reasoning).
 * - gemini     -> generationConfig.thinkingConfig.thinkingLevel (mapped to the nearest
 *                 level the model supports; see lib/llm-gemini-rest.js).
 * Omitted => provider/model default.
 */
function createPreferenceConfig(order = []) {
	const normalizedOrder = Array.isArray(order)
		? order
			.filter((entry) => entry?.PROVIDER && entry?.MODEL)
			.map((entry) => ({
				PROVIDER: entry.PROVIDER,
				MODEL: entry.MODEL,
				...(entry.OPTIONS && typeof entry.OPTIONS === "object"
					? { OPTIONS: { ...entry.OPTIONS } }
					: {}),
			}))
		: [];

	return {
		ORDERED: normalizedOrder,
		PRIMARY: normalizedOrder[0] ?? null,
		FALLBACK: normalizedOrder[1] ?? null,
	};
}

const LUNA = OPENROUTER.MODELS.GPT_6_LUNA;
const HAIKU = OPENROUTER.MODELS.CLAUDE_HAIKU_5_5;

export const LLM_TASK_PREFERENCES = {
	// ~10-30 calls/run (one per scraped page), large inputs, extraction only.
	// Volume too high for free pools as primary; Luna is the most token-efficient cheap model.
	PARSE_EVENTS: createPreferenceConfig([
		{ PROVIDER: "openrouter", MODEL: LUNA, OPTIONS: { REASONING_EFFORT: "low" } },
		{ PROVIDER: "openrouter", MODEL: HAIKU },
		{ PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_3_5_FLASH_LITE },
	]),
	// 1 call/run, judgment-heavy dedupe. Fits Hydrogen's 20 RPD; Haiku (best cheap judgment) next.
	UNIQUE_EVENTS: createPreferenceConfig([
		{ PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_4_HYDROGEN, OPTIONS: { REASONING_EFFORT: "medium" } },
		{ PROVIDER: "openrouter", MODEL: HAIKU, OPTIONS: { REASONING_EFFORT: "low" } },
		{ PROVIDER: "openrouter", MODEL: LUNA, OPTIONS: { REASONING_EFFORT: "medium" } },
	]),
	// ~1-4 calls/run (batches of 30), judgment: merge/dedupe/categorise (no location fields).
	// Hydrogen fits 20 RPD; Haiku then Luna. Watch Haiku's >100K-input price tier on big batches.
	CONSOLIDATE_EVENTS: createPreferenceConfig([
		{ PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_4_HYDROGEN, OPTIONS: { REASONING_EFFORT: "medium" } },
		{ PROVIDER: "openrouter", MODEL: HAIKU },
		{ PROVIDER: "openrouter", MODEL: LUNA },
	]),
	// ~30-100 calls/run (1 per event, paced 4s), small context, knowledge-heavy/low judgment.
	// Google models first (unproven Maps-knowledge theory); free 3.5 Flash-Lite fits 500 RPD,
	// paid OpenRouter copy of the same model next, then Haiku/Luna.
	LOCATE_VENUES: createPreferenceConfig([
		{ PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_3_5_FLASH_LITE },
		{ PROVIDER: "openrouter", MODEL: OPENROUTER.MODELS.GEMINI_3_5_FLASH_LITE },
		{ PROVIDER: "openrouter", MODEL: HAIKU },
		{ PROVIDER: "openrouter", MODEL: LUNA },
	]),
	// 0-2 calls/run (only names/events not settled by exact registry lookups), judgment:
	// "is this the same place/event?". Same profile as CONSOLIDATE_EVENTS; Hydrogen's 20 RPD
	// still covers UNIQUE + CONSOLIDATE + these two per run.
	REGISTRY_MATCHING: createPreferenceConfig([
		{ PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_4_HYDROGEN, OPTIONS: { REASONING_EFFORT: "low" } },
		{ PROVIDER: "openrouter", MODEL: HAIKU },
		{ PROVIDER: "openrouter", MODEL: LUNA, OPTIONS: { REASONING_EFFORT: "low" } },
	]),
	// ~30-100 calls/run (1 per event), trivial date normalisation: reasoning off on Luna.
	DATE_RANGES: createPreferenceConfig([
		{ PROVIDER: "openrouter", MODEL: LUNA, OPTIONS: { REASONING_EFFORT: "none" } },
		{ PROVIDER: "openrouter", MODEL: HAIKU },
		{ PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_3_5_FLASH_LITE },
	]),
	// ~30-100 calls/run, vision, LOW priority. Uses 3.1 Flash-Lite's separate free pool so it
	// never eats 3.5 Flash-Lite's quota (which LOCATE_VENUES/PARSE/DATE fall back to).
	IMAGE_SELECTION: createPreferenceConfig([
		{ PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_3_1_FLASH_LITE },
		{ PROVIDER: "openrouter", MODEL: LUNA, OPTIONS: { REASONING_EFFORT: "low" } },
		{ PROVIDER: "openrouter", MODEL: HAIKU },
	]),
};

// Used by the gateway only when a caller passes no preferenceOrder.
export const LLM_DEFAULT_PREFERENCE_ORDER = LLM_TASK_PREFERENCES.PARSE_EVENTS.ORDERED;

export const EVENT_CATEGORY_GUIDANCE = [
	{
		label: "Arts & Culture",
		description:
			"For museums, art galleries, heritage, and cultural installations.",
	},
	{
		label: "Exhibitions & Fairs",
		description:
			"For focused showcases, from art and history to technology and travel.",
	},
	{
		label: "Family & Kids",
		description:
			"Activities and venues specifically catering to children and families.",
	},
	{
		label: "Festive Celebrations",
		description:
			"For events tied to holidays and seasonal festivities (e.g., Halloween, Deepavali).",
	},
	{
		label: "Food & Drink",
		description:
			"For food festivals, pop-ups, restaurant promotions, and bar events.",
	},
	{
		label: "Music & Nightlife",
		description:
			"For live music, concerts, DJ sets, raves, and late-night parties.",
	},
	{
		label: "Outdoor",
		description:
			"For activities taking place primarily outdoors, including parks, nature, and runs.",
	},
	{
		label: "Shopping & Markets",
		description:
			"For retail-focused events, sales, artisan markets, and bazaars.",
	},
	{
		label: "Sports & Fitness",
		description:
			"For spectator sports, races, fitness classes, and wellness events.",
	},
	{
		label: "Theatre & Performance",
		description:
			"For musicals, plays, dance shows, and other staged performances.",
	},
	{
		label: "Workshops & Talks",
		description:
			"For educational sessions, hands-on classes, masterclasses, and panel discussions.",
	},
];

export const EVENT_CATEGORIES = EVENT_CATEGORY_GUIDANCE.map(
	({ label }) => label
);

export const EVENT_CATEGORY_GUIDANCE_TEXT = EVENT_CATEGORY_GUIDANCE.map(
	({ label, description }) => `-   **${label}:** ${description}`
).join("\n");

export const REGION_GUIDANCE = [
	{
		region: "Central",
		areas: [
			"Marina Bay/CBD",
			"Orchard",
			"Bugis–Bras Basah",
			"Chinatown",
			"Little India",
			"Kampong Glam",
			"Tiong Bahru",
			"Holland Village",
			"Dempsey",
			"Novena–Balestier",
			"Bukit Timah",
		],
	},
	{
		region: "East",
		areas: [
			"Katong–Joo Chiat",
			"Geylang",
			"Paya Lebar",
			"East Coast Park",
			"Tampines",
			"Pasir Ris",
			"Changi (incl. Airport/Jewel)",
		],
	},
	{
		region: "North-East",
		areas: ["Serangoon–NEX", "Kovan", "Hougang", "Sengkang", "Punggol"],
	},
	{
		region: "North",
		areas: ["Yishun", "Sembawang", "Woodlands", "Mandai", "Kranji"],
	},
	{
		region: "West",
		areas: [
			"Clementi",
			"West Coast",
			"Jurong East/Lakeside",
			"Jurong West/Boon Lay",
			"Bukit Batok",
			"Hillview",
			"Tuas",
		],
	},
	{
		region: "Islands & Offshore",
		areas: ["Sentosa", "Pulau Ubin", "Southern Islands"],
	},
];

export const REGION_GUIDANCE_TEXT = REGION_GUIDANCE.map(
	({ region, areas }) => `-   **${region}:** ${areas.join(", ")}`
).join("\n");

export const MRT_NAMING_GUIDANCE = {
	format: "Station Name (LineCodeStationNumber)",
	examples: [
		"Downtown MRT (DT17)",
		"City Hall (EW13 / NS25)",
	],
};

export const MRT_NAMING_GUIDANCE_TEXT = [
	`-   Format: \`${MRT_NAMING_GUIDANCE.format}\``,
	`-   Example: \`${MRT_NAMING_GUIDANCE.examples[0]}\``,
	`-   Interchange Example: \`${MRT_NAMING_GUIDANCE.examples[1]}\``,
].join("\n");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPTS_DIRECTORY = path.join(__dirname, "prompts");

function loadPromptTemplate(fileName, replacements = {}) {
	const fullPath = path.join(PROMPTS_DIRECTORY, fileName);
	let template = fs.readFileSync(fullPath, "utf-8");

	for (const [key, value] of Object.entries(replacements)) {
		const token = `{{${key}}}`;
		template = template.split(token).join(value);
	}

	return template;
}

const SHARED_PROMPT_REPLACEMENTS = {
	EVENT_CATEGORIES: EVENT_CATEGORIES.join(", "),
	EVENT_CATEGORY_GUIDANCE: EVENT_CATEGORY_GUIDANCE_TEXT,
	REGION_GUIDANCE: REGION_GUIDANCE_TEXT,
	MRT_NAMING_GUIDANCE: MRT_NAMING_GUIDANCE_TEXT,
};

export const PROMPT_TEMPLATES = {
	PARSE_EVENTS_AS_JSON: loadPromptTemplate(
		"parse-events-as-json.txt",
		SHARED_PROMPT_REPLACEMENTS
	),
	// 	COMBINE_JSON_SYSTEM_MESSAGE: `
	// You will be given a few JSON arrays, separated by ===. Please summarise them in the following ways:

	// 1) Combine repeated items or items with similar looking titles or sharing distinct words in the title. Be proactive about combining potential repeats. When combining items, do combine the other fields as well.

	// 2) Retain the general fields in the provided JSON

	// 3) Summarise into a single JSON array. Respond with just the array, without any helper text or explanation.
	// `,
	GET_UNIQUE_EVENTS_SYSTEM_MESSAGE: loadPromptTemplate(
		"get-unique-events-system-message.txt"
	),
	PREPARE_UNIQUE_EVENTS_DATA_SYSTEM_MESSAGE: loadPromptTemplate(
		"prepare-unique-events-data-system-message.txt",
		SHARED_PROMPT_REPLACEMENTS
	),
	FORMAT_DATE_RANGE_SYSTEM_MESSAGE: loadPromptTemplate(
		"format-date-range-system-message.txt"
	),
	SELECT_EVENT_IMAGE_SYSTEM_MESSAGE: loadPromptTemplate(
		"select-event-image-system-message.txt"
	),
	LOCATE_VENUES_SYSTEM_MESSAGE: loadPromptTemplate(
		"locate-venues-system-message.txt",
		SHARED_PROMPT_REPLACEMENTS
	),
	RESOLVE_VENUES_SYSTEM_MESSAGE: loadPromptTemplate(
		"resolve-venues-system-message.txt"
	),
	MATCH_EVENTS_SYSTEM_MESSAGE: loadPromptTemplate(
		"match-events-system-message.txt"
	),
};
