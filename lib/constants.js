export const URLS_TO_SCRAPE = [
	"https://www.esplanade.com/whats-on/festivals-and-series/series/beautiful-sunday",
	"https://www.timeout.com/singapore/things-to-do/things-to-do-in-singapore-this-weekend",
	"https://www.visitsingapore.com/editorials/whats-happening-in-singapore/",
	"https://thehoneycombers.com/singapore/things-to-do-this-weekend-singapore/",
	"https://secretsingapore.co/best-things-to-do-this-weekend/",
	"https://www.lifestyleasia.com/sg/culture/events/best-things-events-to-do-in-singapore-this-week-and-weekend/",
	"https://www.esplanade.com/",
	"https://www.timeout.com/singapore/things-to-do/the-time-out-singapore-hotlist",
];

export const RETRY_COUNT = 3;

export const VERTEX = {
	LOCATION: "us-central1",
	PUBLISHER: "google",
	MODEL: "text-bison-32k",
};

export const OPENAI = {
	MODEL_GPT4: "gpt-4-1106-preview",
	MODEL_GPT3_5: "gpt-3.5-turbo-16k",
	// MAX_TOKENS: 4095,
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

export const PROMPT_TEMPLATES = {
	PARSE_EVENTS_AS_JSON: `
You will look at my input, and extract all the events that are happening. Please provide them in JSON format, as an array of objects:
- title (String)
- description (String, 1 to 2 lines)
- location (String)
- datetime (String, try to provide exact dates or date ranges)
- category (Array, based on the following categories: ${EVENT_CATEGORIES.join(
		", "
	)})

===
{content}
===
`,
	// 	COMBINE_JSON_SYSTEM_MESSAGE: `
	// You will be given a few JSON arrays, separated by ===. Please summarise them in the following ways:

	// 1) Combine repeated items or items with similar looking titles or sharing distinct words in the title. Be proactive about combining potential repeats. When combining items, do combine the other fields as well.

	// 2) Retain the general fields in the provided JSON

	// 3) Summarise into a single JSON array. Respond with just the array, without any helper text or explanation.
	// `,
	GET_UNIQUE_EVENTS_SYSTEM_MESSAGE: `
You will be given a JSON array. Please summarise the items inside in the following ways:

1) Drop any items that are duplicated (e.g repeated items or items with similar looking titles or sharing distinct words in the title). Be proactive about dropping potential repeats.

2) Drop any items that doesn't sound like a specific event, or sounds too generic (ie a general suggestion).

3) Summarise into a single JSON array. Respond with just this array, without any helper text or explanation.
`,
	PREPARE_UNIQUE_EVENTS_DATA_SYSTEM_MESSAGE: `
You will be given a few JSON arrays, separated by ===. These are your overall data sources.

From these data sources, we have identified the following unique events, as so:
{uniqueEvents}

For each unique event, please reference the data sources, and collate for the following information:
- title (String)
- description (String, 1 to 2 lines)
- location (String)
- datetime (String)
- category (Array, based on the following categories: ${EVENT_CATEGORIES.join(
		", "
	)})
- source (Array): data source numbers

When collating information, feel free to pick and choose from various data sources. Do prefer information that is more specific.

Summarise into a single JSON array. Respond with just the array, without any helper text or explanation.
`,
};
