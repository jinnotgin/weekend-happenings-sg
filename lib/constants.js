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

export const GEMINI = {
        LOCATION: "global",  // used by vertex AI, legacy, to remove
        LEGACY_VERTEX_MODEL: "gemini-pro",    // used by vertex AI, legacy, to remove
        MODELS: {
                GEMINI_3_PRO: "gemini-3-pro-preview",
                GEMINI_3_FLASH: "gemini-3-flash-preview",
                GEMINI_2_5_PRO: "gemini-2.5-pro",
                GEMINI_2_5_FLASH: "gemini-2.5-flash",
                GEMINI_2_5_FLASH_LITE: "gemini-2.5-flash-lite",
        },
};

// Legacy Vertex configuration retained for archived helpers.
export const VERTEX = {
        LOCATION: "us-central1",
        PUBLISHER: "google",
        MODEL: "text-bison-32k",
};

export const OPENAI = {
        MODEL_GPT5_2: "gpt-5.2",
        MODEL_GPT5: "gpt-5",
        MODEL_GPT5_MINI: "gpt-5-mini",
        MODEL_GPT5_NANO: "gpt-5-nano",
        MODEL_GPT4o: "gpt-4o-2024-05-13",
        MODEL_GPT4: "gpt-4-turbo-2024-04-09",
        MODEL_GPT3_5: "gpt-3.5-turbo-0125",
        // MAX_TOKENS: 4095,
};

export const OPENROUTER = {
        MODELS_SMART: {
                GEMINI_3_FLASH: "google/gemini-3-flash-preview",
				},
				MODELS_MEDIUM: {
								GPT_OSS_120B: "openai/gpt-oss-120b:exacto",
				},
        // Fast models (equivalent to "nano"-style extraction tasks).
        MODELS_FAST: {
                GEMMA_3_27B_FREE: "google/gemma-3-27b-it:free",
                GEMMA_3_27B: "google/gemma-3-27b-it",
                MISTRAL_SMALL_3_1_24B_FREE: "mistralai/mistral-small-3.1-24b-instruct:free",
        },
        // Image-capable model for thumbnail selection.
        MODELS_IMAGE: {
                GEMMA_3_27B_FREE: "google/gemma-3-27b-it:free",
                GEMMA_3_27B: "google/gemma-3-27b-it",
        },
};

export const NIM = {
	// Models below are tested to return structured outputs successfully.
	MODELS_SMART: {
		// KIMI_K2_5: "moonshotai/kimi-k2.5", // DISABLED due to high popularity
		KIMI_K2_THINKING: "moonshotai/kimi-k2-thinking",
		DEEPSEEK_V3_2: "deepseek-ai/deepseek-v3.2",
	},
	MODELS_MEDIUM: {
		GLM_4_7: "z-ai/glm4.7",
		QWEN3_235B_A22B: "qwen/qwen3-235b-a22b",
		STEP_3_5_FLASH: "stepfun-ai/step-3.5-flash",
	},
	MODELS_IMAGE: {
		LLAMA_4_MAVERICK_17B_128E_INSTRUCT:
			"meta/llama-4-maverick-17b-128e-instruct",
		LLAMA_4_SCOUT_17B_16E_INSTRUCT:
			"meta/llama-4-scout-17b-16e-instruct",
	},
};

export const IMAGE_SELECTION_CONFIG = {
        MAX_IMAGE_CANDIDATES: 6,
        MAX_INLINE_IMAGE_BYTES: 20 * 1024 * 1024, // Gemini inline_data limit
        MAX_IMAGE_CANDIDATES_BY_PROVIDER: {
                nim: 5,
        },
};

function createPreferenceConfig(order = []) {
        const normalizedOrder = Array.isArray(order)
                ? order
                        .filter((entry) => entry?.PROVIDER && entry?.MODEL)
                        .map((entry) => ({
                                PROVIDER: entry.PROVIDER,
                                MODEL: entry.MODEL,
                        }))
                : [];

        return {
                ORDERED: normalizedOrder,
                PRIMARY: normalizedOrder[0] ?? null,
                FALLBACK: normalizedOrder[1] ?? null,
        };
}

export const LLM_TASK_PREFERENCES = {
        PARSE_EVENTS: createPreferenceConfig([
                { PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_2_5_FLASH },
                { PROVIDER: "nim", MODEL: NIM.MODELS_SMART.KIMI_K2_THINKING },
                { PROVIDER: "nim", MODEL: NIM.MODELS_SMART.DEEPSEEK_V3_2 },
                { PROVIDER: "openrouter", MODEL: OPENROUTER.MODELS_MEDIUM.GPT_OSS_120B },
                { PROVIDER: "openai", MODEL: OPENAI.MODEL_GPT5_MINI },
        ]),
        UNIQUE_EVENTS: createPreferenceConfig([
                { PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_3_FLASH },
                { PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_2_5_PRO },
                { PROVIDER: "nim", MODEL: NIM.MODELS_SMART.KIMI_K2_THINKING },
                { PROVIDER: "nim", MODEL: NIM.MODELS_SMART.DEEPSEEK_V3_2 },
                { PROVIDER: "openrouter", MODEL: OPENROUTER.MODELS_SMART.GEMINI_3_FLASH },
                { PROVIDER: "openai", MODEL: OPENAI.MODEL_GPT5_2 },
        ]),
        CONSOLIDATE_EVENTS: createPreferenceConfig([
                { PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_3_FLASH },
                { PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_2_5_PRO },
                { PROVIDER: "nim", MODEL: NIM.MODELS_SMART.KIMI_K2_THINKING },
                { PROVIDER: "nim", MODEL: NIM.MODELS_SMART.DEEPSEEK_V3_2 },
                { PROVIDER: "openrouter", MODEL: OPENROUTER.MODELS_SMART.GEMINI_3_FLASH },
                { PROVIDER: "openai", MODEL: OPENAI.MODEL_GPT5_2 },
        ]),
        DATE_RANGES: createPreferenceConfig([
                { PROVIDER: "openrouter", MODEL: OPENROUTER.MODELS_FAST.GEMMA_3_27B_FREE },
                { PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_2_5_FLASH_LITE },
                { PROVIDER: "nim", MODEL: NIM.MODELS_MEDIUM.GLM_4_7 },
                { PROVIDER: "nim", MODEL: NIM.MODELS_MEDIUM.QWEN3_235B_A22B },
                { PROVIDER: "nim", MODEL: NIM.MODELS_MEDIUM.STEP_3_5_FLASH },
                { PROVIDER: "openrouter", MODEL: OPENROUTER.MODELS_FAST.GEMMA_3_27B },
                { PROVIDER: "openai", MODEL: OPENAI.MODEL_GPT5_NANO },
        ]),
        IMAGE_SELECTION: createPreferenceConfig([
                { PROVIDER: "openrouter", MODEL: OPENROUTER.MODELS_IMAGE.GEMMA_3_27B_FREE },
                { PROVIDER: "gemini", MODEL: GEMINI.MODELS.GEMINI_2_5_FLASH_LITE },
                { PROVIDER: "nim", MODEL: NIM.MODELS_IMAGE.LLAMA_4_MAVERICK_17B_128E_INSTRUCT },
                { PROVIDER: "openrouter", MODEL: OPENROUTER.MODELS_IMAGE.GEMMA_3_27B },
                { PROVIDER: "openai", MODEL: OPENAI.MODEL_GPT5_NANO },
        ]),
};

const ORDERED_LLM_PREFERENCES = LLM_TASK_PREFERENCES.CONSOLIDATE_EVENTS.ORDERED;

export const LLM_PREFERENCES = {
        ORDERED: ORDERED_LLM_PREFERENCES,
        PRIMARY: LLM_TASK_PREFERENCES.CONSOLIDATE_EVENTS.PRIMARY,
        FALLBACK: LLM_TASK_PREFERENCES.CONSOLIDATE_EVENTS.FALLBACK,
};

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
};
