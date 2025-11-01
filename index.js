import "dotenv/config";

import logger from "#lib/logger.js";
import {
        // URLS_TO_SCRAPE,
        SERACH_TERM_FOR_EVENTS,
        BLACKLISTED_DOMAINS,
        PROMPT_TEMPLATES,
        RETRY_COUNT,
} from "#lib/constants.js";
import { scrapeUrlForTextTags } from "#lib/crawler.js";
import {
	clearDataDirectory,
	saveAsText,
	getFilePath,
	getDirectoryPath,
} from "#lib/diskio.js";
import { generateJsonWithFallback } from "#lib/llm-gateway.js";
import { retryAsyncFunction, parseOrRecoverJsonString } from "#lib/utils.js";
// import { getWebLinkAndSaveImage } from "#lib/bing-search.js";
import {
	getSearchResultsUrls,
	getWebLinkAndSaveImage,
} from "#lib/google-search.js";
import { uploadAndUpdateLatest } from "#lib/upload-r2.js";

export async function main() {
	await clearDataDirectory();

	let eventsData_combinedJsonString = "";
	const eventsData = {};

	const NUMBER_OF_SEARCH_PAGE_RESULTS = 2;
	const URLS_TO_SCRAPE = (
		await retryAsyncFunction(
			getSearchResultsUrls,
			RETRY_COUNT,
			SERACH_TERM_FOR_EVENTS,
			NUMBER_OF_SEARCH_PAGE_RESULTS
		)
	).filter(
		(url) =>
			!BLACKLISTED_DOMAINS.some((blacklistedUrl) =>
				url.includes(blacklistedUrl)
			)
	);

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
                                generateJsonWithFallback,
                                RETRY_COUNT,
                                PROMPT_TEMPLATES.PARSE_EVENTS_AS_JSON.replace("{content}", data) // TODO: move to system message
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
                generateJsonWithFallback,
                RETRY_COUNT,
                JSON.stringify(allTitles),
                {
                        systemMessage: PROMPT_TEMPLATES.GET_UNIQUE_EVENTS_SYSTEM_MESSAGE,
                        temperature: 0,
                }
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
                generateJsonWithFallback,
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
	async function processDateRange(datetime, retryCount = 3) {
		function formatDate(date = new Date()) {
			return `${date
				.getDate()
				.toString()
				.padStart(2, "0")} ${date.toLocaleString("default", {
				month: "short",
			})} ${date.getFullYear()}`;
		}

		function isValidDateRange(dateRange) {
			return Array.isArray(dateRange) && dateRange.length === 2;
		}

		for (let attempt = 0; attempt < retryCount; attempt++) {
                        const response_dateRange_jsonString = await retryAsyncFunction(
                                generateJsonWithFallback,
                                RETRY_COUNT,
                                JSON.stringify([datetime]),
                                {
                                        systemMessage:
                                                PROMPT_TEMPLATES.FORMAT_DATE_RANGE_SYSTEM_MESSAGE.replace(
                                                        "{todayDate}",
                                                        formatDate()
                                                ),
                                }
                        );

			const response_dateRange = parseOrRecoverJsonString(
				response_dateRange_jsonString
			);
			const dateRange = response_dateRange[0];

			if (isValidDateRange(dateRange)) {
				return dateRange;
			}

			logger.warn(
				`Attempt ${
					attempt + 1
				}: Received null daterange for datetime: ${datetime}. Retrying...`
			);
		}

		throw new Error(
			`Failed to generate valid daterange for datetime: ${datetime} after ${retryCount} attempts`
		);
	}

	for (let item of uniqueEventsData) {
		try {
			logger.info(`Processing date range for event: ${item.title}`);
			const dateRange = await processDateRange(item.datetime);
			item.daterange = dateRange;
			logger.info(`Successfully added date range for event: ${item.title}`);
		} catch (error) {
			logger.error(
				`Error processing date range for event: ${item.title}`,
				error
			);
			// You might want to set a default value or flag here
			item.daterange = "Error: Unable to process";
		}
	}

	logger.info("Getting event URL and images via web search");
	for (let item of uniqueEventsData) {
		const { title = "", location = "", datetime = "" } = item;
		try {
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
		} catch (error) {
			logger.error(
				`Unable to fetch link / image for ${title}: ${error.message}`
			);
		}
	}

	saveAsText(
		JSON.stringify(uniqueEventsData),
		getFilePath("compiled", `events`, "json")
	);

	saveAsText(
		JSON.stringify(new Date().toISOString()),
		getFilePath("compiled", `generationTime`, "json")
	);

	return await uploadAndUpdateLatest(getDirectoryPath("compiled"));
}
