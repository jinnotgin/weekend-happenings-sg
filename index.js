import "dotenv/config";

import logger from "#lib/logger.js";
import {
	URLS_TO_SCRAPE,
	PROMPT_TEMPLATES,
	RETRY_COUNT,
	OPENAI,
} from "#lib/constants.js";
import { scrapeUrlForTextTags } from "#lib/crawler.js";
import { clearDataDirectory, saveAsText, getFilePath } from "#lib/diskio.js";
import { generateText as vertex_generateText } from "#lib/llm-vertex-gemini.js";
import { generateJson as opennai_generateJson } from "#lib/llm-openai.js";
import { retryAsyncFunction, parseOrRecoverJsonString } from "#lib/utils.js";
import { getWebLinkAndSaveImage } from "#lib/bing-search.js";

async function main() {
	await clearDataDirectory();

	let eventsData_combinedJsonString = "";
	const eventsData = {};

	logger.info("Starting to scrape");
	const sources = [];
	for (let index = 0; index < URLS_TO_SCRAPE.length; index++) {
		const url = URLS_TO_SCRAPE[index];
		try {
			logger.info(`Getting text from ${url}`);
			const { title = null, data = null } = await retryAsyncFunction(
				scrapeUrlForTextTags,
				RETRY_COUNT,
				url
			);
			if (!data) throw new Error("No data available.");

			sources.push({ title, url });
			saveAsText(data, getFilePath("tmp", `raw_${index}`, "txt"));

			logger.info(`Extracting events data as JSON for ${url}`);
			const eventsJsonStr = await retryAsyncFunction(
				// vertex_generateText,
				opennai_generateJson,
				RETRY_COUNT,
				PROMPT_TEMPLATES.PARSE_EVENTS_AS_JSON.replace("{content}", data), // TODO: move to system message
				{ model: OPENAI.MODEL_GPT3_5 }
			);

			saveAsText(eventsJsonStr, getFilePath("tmp", `json_${index}`, "txt"));

			eventsData[url] = parseOrRecoverJsonString(eventsJsonStr);
			eventsData_combinedJsonString += `Source: ${index}\n${eventsJsonStr}\n===\n`;
		} catch (error) {
			logger.error(`Error occured when scraping ${url}`, error);
		}
	}
	saveAsText(
		JSON.stringify(sources),
		getFilePath("compiled", `sources`, "json")
	);

	const allTitles = Object.values(eventsData)
		.flat()
		.map((item) => item.title);

	logger.info("Generating a list of unique events");
	const allUniqueTitles_jsonString = await retryAsyncFunction(
		opennai_generateJson,
		RETRY_COUNT,
		JSON.stringify(allTitles),
		{ systemMessage: PROMPT_TEMPLATES.GET_UNIQUE_EVENTS_SYSTEM_MESSAGE }
	);
	const allUniqueTitles = parseOrRecoverJsonString(allUniqueTitles_jsonString);

	logger.info(`A total of ${allUniqueTitles.length} unique events found.`, {
		allUniqueTitles,
	});
	saveAsText(
		allUniqueTitles_jsonString,
		getFilePath("tmp", `unique_events`, "json")
	);

	logger.info("Collating the data for each unique event");
	const uniqueEventsData_jsonString = await retryAsyncFunction(
		opennai_generateJson,
		RETRY_COUNT,
		eventsData_combinedJsonString,
		{
			systemMessage:
				PROMPT_TEMPLATES.PREPARE_UNIQUE_EVENTS_DATA_SYSTEM_MESSAGE.replace(
					"{uniqueEvents}",
					`- ${allUniqueTitles.join("\n- ")}`
				),
		}
	);

	const uniqueEventsData = parseOrRecoverJsonString(
		uniqueEventsData_jsonString
	);

	logger.info("Generating structured datetimes");
	const dateTimes = uniqueEventsData.map((item) => item.datetime);
	let dateRanges = null;
	for (let i = 0; i < RETRY_COUNT; i++) {
		function formatDate(date = new Date()) {
			// const day = date.toLocaleString("default", { weekday: "long" });
			return `${date
				.getDate()
				.toString()
				.padStart(2, "0")} ${date.toLocaleString("default", {
				month: "short",
			})} ${date.getFullYear()}`;
		}
		const response_dateRanges_jsonString = await retryAsyncFunction(
			opennai_generateJson,
			RETRY_COUNT,
			JSON.stringify(dateTimes),
			{
				systemMessage:
					PROMPT_TEMPLATES.FORMAT_DATE_RANGE_SYSTEM_MESSAGE.replace(
						"{todayDate}",
						formatDate()
					),
			}
		);
		const response_dateRanges = parseOrRecoverJsonString(
			response_dateRanges_jsonString
		);
		if (dateTimes.length === response_dateRanges.length) {
			dateRanges = response_dateRanges;
			break;
		}
	}
	if (dateRanges && Array.isArray(dateRanges)) {
		dateRanges.forEach((value, index) => {
			uniqueEventsData[index].daterange = value;
		});
		logger.info(`Found date ranges and added them into uniqueEventsData.`);
	} else {
		logger.error(
			`Unable to convert into date ranges, LLM output length mismatched.`
		);
	}

	logger.info("Getting event URL and images via web search");
	for (let item of uniqueEventsData) {
		const { title = "", location = "", datetime = "" } = item;
		const searchQuery = `"${title} singapore`;
		logger.info(`Getting link and thumbnail for ${title}`);

		const { firstWebUrl, savedImageFileName } = await retryAsyncFunction(
			getWebLinkAndSaveImage,
			RETRY_COUNT,
			searchQuery
		);

		logger.info(`Found the following for ${title}`, {
			firstWebUrl,
			savedImageFileName,
		});

		item.link = firstWebUrl;
		item.thumbnail = savedImageFileName;
	}

	saveAsText(
		JSON.stringify(uniqueEventsData),
		getFilePath("compiled", `events`, "json")
	);

	saveAsText(
		JSON.stringify(new Date().toISOString()),
		getFilePath("compiled", `generationTime`, "json")
	);
}

try {
	await main();
} catch (error) {
	logger.error(`error: ${error.message}`);
}
