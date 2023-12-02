export const URLS_TO_SCRAPE = [
	"https://www.esplanade.com/whats-on/festivals-and-series/series/beautiful-sunday",
	"https://www.timeout.com/singapore/things-to-do/things-to-do-in-singapore-this-weekend",
	"https://www.visitsingapore.com/editorials/whats-happening-in-singapore/",
	"https://thehoneycombers.com/singapore/things-to-do-this-weekend-singapore/",
	"https://secretsingapore.co/best-things-to-do-this-weekend/",
];

export const RETRY_COUNT = 3;

export const VERTEX = {
	LOCATION: "us-central1",
	PUBLISHER: "google",
	MODEL: "text-bison-32k",
};

export const OPENAI = {
	MODEL: "gpt-3.5-turbo-1106",
	MAX_TOKENS: 4095,
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
- category (Array, based on the following categories: ${EVENT_CATEGORIES.join(
		", "
	)})
- description (String, 1 to 2 lines)
- location (String)
- datetime (String)

===
{content}
===
`,
	COMBINE_JSON_SYSTEM_MESSAGE: `
Return an array of combined results. Take note remove any potential duplicates (merge them together). 

Datetimes should be in either of this format: a) "DD-MM-YYYY HH:MM", b) "From DD-MM-YYYY to DD-MM-YYYY" or c) "Until DD-MM-YYYY"

Category arrays should only have the following category items: 
- ${EVENT_CATEGORIES.join("\n- ")}
If have others, find the best match from the above.

Respond with just the json.
`,
};
