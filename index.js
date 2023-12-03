import "dotenv/config";

import logger from "#lib/logger.js";
import {
	URLS_TO_SCRAPE,
	PROMPT_TEMPLATES,
	RETRY_COUNT,
} from "#lib/constants.js";
import { scrapeUrlForTextTags } from "#lib/scraper.js";
import { saveAsText } from "#lib/diskio.js";
import { generateText as vertex_generateText } from "#lib/vertex.js";
import { generateJson as opennai_generateJson } from "#lib/openai.js";
import {
	retryAsyncFunction,
	parseOrRecoverJsonString,
	removeMarkdownSyntax,
} from "#lib/utils.js";

async function main() {
	let eventsData_combinedJsonString = "";
	const eventsData = {};

	logger.info("Starting to scrape");
	let counter = 0;
	for (let url of URLS_TO_SCRAPE) {
		try {
			logger.info(`Getting text from ${url}`);
			const data = await retryAsyncFunction(
				scrapeUrlForTextTags,
				RETRY_COUNT,
				url
			);

			saveAsText(data, `raw_${counter}.txt`);

			logger.info(`Extracting events data as JSON for ${url}`);
			const eventsJsonStr = await retryAsyncFunction(
				vertex_generateText,
				RETRY_COUNT,
				PROMPT_TEMPLATES.PARSE_EVENTS_AS_JSON.replace("{content}", data)
			);
			saveAsText(eventsJsonStr, `json_${counter}.txt`);

			eventsData[url] = parseOrRecoverJsonString(eventsJsonStr);
			eventsData_combinedJsonString += `Source: ${counter}\n${eventsJsonStr}\n===\n`;

			counter++;
		} catch (error) {
			logger.error(`Error occured when scraping ${url}`, error);
		}
	}

	const allTitles = Object.values(eventsData)
		.flat()
		.map((item) => item.title);

	logger.info("Generating a list of unique events");
	const allUniqueTitles_jsonString = await retryAsyncFunction(
		opennai_generateJson,
		RETRY_COUNT,
		JSON.stringify(allTitles),
		PROMPT_TEMPLATES.GET_UNIQUE_EVENTS_SYSTEM_MESSAGE
	);
	const allUniqueTitles = parseOrRecoverJsonString(allUniqueTitles_jsonString);
	logger.info(`A total of ${allUniqueTitles.length} unique events found.`, {
		allUniqueTitles,
	});
	saveAsText(allUniqueTitles_jsonString, `unique_events.json`);

	logger.info("Collating the data for each unique event");
	const uniqueEventsData_jsonString = await retryAsyncFunction(
		opennai_generateJson,
		RETRY_COUNT,
		eventsData_combinedJsonString,
		PROMPT_TEMPLATES.PREPARE_UNIQUE_EVENTS_DATA_SYSTEM_MESSAGE.replace(
			"{uniqueEvents}",
			`- ${allUniqueTitles.join("\n- ")}`
		)
	);
	saveAsText(removeMarkdownSyntax(uniqueEventsData_jsonString), `final.json`);
}

try {
	await main();
} catch (error) {
	logger.error(`error: ${error.message}`);
}
