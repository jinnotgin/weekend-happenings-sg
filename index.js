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
import { generateText as opennai_generateText } from "#lib/openai.js";
import { retryAsyncFunction, parseOrRecoverJsonString } from "#lib/utils.js";

async function main() {
	let allJsonStrings = "";

	logger.info("Starting to scrape");
	let counter = 0;
	for (let url of URLS_TO_SCRAPE) {
		try {
			counter++;
			logger.info(`Getting text from ${url}`);
			const data = await retryAsyncFunction(
				scrapeUrlForTextTags,
				RETRY_COUNT,
				url
			);

			saveAsText(data, `raw_${counter}.txt`);

			logger.info(`Extract events data as JSON for ${url}`);
			const eventsJsonStr = await retryAsyncFunction(
				vertex_generateText,
				RETRY_COUNT,
				PROMPT_TEMPLATES.PARSE_EVENTS_AS_JSON.replace("{content}", data)
			);
			saveAsText(eventsJsonStr, `json_${counter}.txt`);
			allJsonStrings += `===\n${eventsJsonStr}\n===\n`;
		} catch (error) {
			logger.error(`Error occured when scraping ${url}`, error);
		}
	}

	async function combineDedupVerifyParseJson() {
		const combinedJsonStr = await opennai_generateText(
			allJsonStrings,
			PROMPT_TEMPLATES.COMBINE_JSON_SYSTEM_MESSAGE
		);

		const outputObject = parseOrRecoverJsonString(combinedJsonStr);
		return outputObject;
	}

	console.log(allJsonStrings);
	logger.info(`Combining all JSON data together`);
	const eventsList = await retryAsyncFunction(
		combineDedupVerifyParseJson,
		RETRY_COUNT
	);
	saveAsText(JSON.stringify(eventsList), `final.json`);
}

try {
	await main();
} catch (error) {
	logger.error("Error occured", error);
}
