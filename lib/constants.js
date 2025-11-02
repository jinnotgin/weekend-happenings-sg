import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const URLS_TO_SCRAPE = [
	"https://www.timeout.com/singapore/things-to-do/things-to-do-in-singapore-this-weekend",
	"https://www.visitsingapore.com/editorials/whats-happening-in-singapore/",
	"https://thehoneycombers.com/singapore/things-to-do-this-weekend-singapore/",
	"https://secretsingapore.co/best-things-to-do-this-weekend/",
	"https://www.lifestyleasia.com/sg/culture/events/best-things-events-to-do-in-singapore-this-week-and-weekend/",
	"https://www.timeout.com/singapore/things-to-do/the-time-out-singapore-hotlist",
	// "https://www.esplanade.com/whats-on/festivals-and-series/series/beautiful-sunday",
];
export const SERACH_TERM_FOR_EVENTS = "things to do singapore";
export const BLACKLISTED_DOMAINS = [
	"https://www.eventbrite.sg/",
	"https://nowinsg.com/",
	"https://thetravelintern.com/",
];

export const RETRY_COUNT = 3;

export const GEMINI = {
        LOCATION: "us-central1",
        LEGACY_VERTEX_MODEL: "gemini-pro",
        MODELS: {
                GEMINI_2_5_FLASH: "gemini-2.5-flash",
                GEMINI_2_5_PRO: "gemini-2.5-pro",
        },
};

// Legacy Vertex configuration retained for archived helpers.
export const VERTEX = {
        LOCATION: "us-central1",
        PUBLISHER: "google",
        MODEL: "text-bison-32k",
};

export const OPENAI = {
        MODEL_GPT5_MINI: "gpt-5-mini",
        MODEL_GPT4o: "gpt-4o-2024-05-13",
        MODEL_GPT4: "gpt-4-turbo-2024-04-09",
        MODEL_GPT3_5: "gpt-3.5-turbo-0125",
        // MAX_TOKENS: 4095,
};

const ORDERED_LLM_PREFERENCES = [
        {
                PROVIDER: "gemini",
                MODEL: GEMINI.MODELS.GEMINI_2_5_FLASH,
        },
        {
                PROVIDER: "openai",
                MODEL: OPENAI.MODEL_GPT5_MINI,
        },
];

export const LLM_PREFERENCES = {
        ORDERED: ORDERED_LLM_PREFERENCES,
        PRIMARY: ORDERED_LLM_PREFERENCES[0],
        FALLBACK: ORDERED_LLM_PREFERENCES[1] ?? null,
};

export const EVENT_CATEGORIES = [
	"Festive Celebrations",
	"Arts and Culture",
	"Family and Kids",
	"Entertainment and Lifestyle",
	"Shopping and Exhibitions",
	"Outdoor",
	"Additional Events",
];

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

export const PROMPT_TEMPLATES = {
	PARSE_EVENTS_AS_JSON: loadPromptTemplate("parse-events-as-json.txt", {
		EVENT_CATEGORIES: EVENT_CATEGORIES.join(", "),
	}),
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
		{ EVENT_CATEGORIES: EVENT_CATEGORIES.join(", ") }
	),
	FORMAT_DATE_RANGE_SYSTEM_MESSAGE: loadPromptTemplate(
		"format-date-range-system-message.txt"
	),
};
