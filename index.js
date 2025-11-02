import "dotenv/config";

import logger from "#lib/logger.js";
import {
	FIXED_URLS_TO_SCRAPE,
	SCRAPER_OPTIONS,
	SEARCH_TERM_FOR_EVENTS,
	BLACKLISTED_DOMAINS,
	PROMPT_TEMPLATES,
	RETRY_COUNT,
	LLM_PREFERENCES,
} from "#lib/constants.js";
import { scrapeUrlForTextTags } from "#lib/crawler.js";
import {
	clearDataDirectory,
	saveAsText,
	getFilePath,
	getDirectoryPath,
} from "#lib/diskio.js";
import { generateAndParseJson } from "#lib/llm-gateway.js";
import { retryAsyncFunction } from "#lib/utils.js";
import {
	PARSED_EVENTS_RESPONSE_SCHEMA,
	UNIQUE_EVENT_TITLES_RESPONSE_SCHEMA,
	CONSOLIDATED_EVENTS_RESPONSE_SCHEMA,
	DATE_RANGES_RESPONSE_SCHEMA,
} from "#lib/schemas/index.js";
// import { getWebLinkAndSaveImage } from "#lib/bing-search.js";
import {
	getSearchResultsUrls,
	getWebLinkAndSaveImage,
} from "#lib/google-search.js";
import { uploadAndUpdateLatest } from "#lib/upload-r2.js";


function formatMonthYear(date) {
	return `${date.toLocaleString("en-US", { month: "short" })} ${date.getFullYear()}`;
}

function generateSearchTerms(baseTerm) {
	const normalizedBase = baseTerm.trim();
	const today = new Date();
	const nextMonthDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);

	return [
		`${normalizedBase} this weekend`,
		`${normalizedBase} in ${formatMonthYear(today)}`,
		`${normalizedBase} in ${formatMonthYear(nextMonthDate)}`,
	];
}

export async function main() {
	await clearDataDirectory();
	logger.info("Stage: Data directory cleared");

	let eventsData_combinedJsonString = "";
	const eventsData = {};

	const shouldPerformWebSearch = Boolean(SCRAPER_OPTIONS?.PERFORM_WEB_SEARCH);
	const fixedUrls = Array.isArray(FIXED_URLS_TO_SCRAPE)
		? FIXED_URLS_TO_SCRAPE
		: [];
	let searchTerms = [];
	let searchResultUrls = [];

	if (shouldPerformWebSearch) {
		const NUMBER_OF_SEARCH_PAGE_RESULTS = 2;
		logger.info("Stage: Generating search terms");
		searchTerms = generateSearchTerms(SEARCH_TERM_FOR_EVENTS);
		logger.info("Search terms in use", { searchTerms });

		logger.info("Stage: Fetching search results");
		const urlsBySearchTerm = await Promise.all(
			searchTerms.map(async (searchTerm) => {
				const urls = await retryAsyncFunction(
					getSearchResultsUrls,
					RETRY_COUNT,
					searchTerm,
					NUMBER_OF_SEARCH_PAGE_RESULTS
				);
				logger.info(`Fetched ${urls.length} urls`, { searchTerm });
				return urls;
			})
		);

		searchResultUrls = [...new Set(urlsBySearchTerm.flat())];
		logger.info("Stage: Search results collected", {
			totalUniqueUrls: searchResultUrls.length,
			searchTermCount: searchTerms.length,
		});
	} else {
		logger.info("Stage: Web search disabled; skipping Google search results");
	}

	const urlsToScrape = [...new Set([...fixedUrls, ...searchResultUrls])].filter(
		(url) =>
			!BLACKLISTED_DOMAINS.some((blacklistedUrl) =>
				url.includes(blacklistedUrl)
			)
	);
	logger.info("Stage: Preparing URL list", {
		fixedUrlCount: fixedUrls.length,
		searchResultUrlCount: searchResultUrls.length,
	});
	logger.info(`Total unique urls to scrape: ${urlsToScrape.length}`);

	logger.info("Stage: Scraping sources started");
	const sources = [];
	let scrapeFailures = 0;
	for (let index = 0; index < urlsToScrape.length; index++) {
		const url = urlsToScrape[index];
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
			const {
				rawJson: eventsJsonStr,
				parsedJson: parsedEventsPayload,
			} = await retryAsyncFunction(
				generateAndParseJson,
				RETRY_COUNT,
				PROMPT_TEMPLATES.PARSE_EVENTS_AS_JSON.replace("{content}", data), // TODO: move to system message
				{
					responseSchema: {
						name: "ParsedEvents",
						schema: PARSED_EVENTS_RESPONSE_SCHEMA,
					},
				}
			);

			saveAsText(eventsJsonStr, getFilePath("tmp", `json_${index}`, "txt"));

			const parsedEvents = Array.isArray(parsedEventsPayload?.events)
				? parsedEventsPayload.events
				: [];

			eventsData[url] = parsedEvents;
			eventsData_combinedJsonString += `Source: ${index}\n${eventsJsonStr}\n===\n`;
		} catch (error) {
			scrapeFailures += 1;
			logger.error(`Error occured when scraping ${url}`, {
				errorMessage: error?.message,
				stack: error?.stack,
			});
		}
	}
	logger.info("Stage: Scraping sources completed", {
		successfulSources: sources.length,
		failedSources: scrapeFailures,
	});
	saveAsText(
		JSON.stringify(sources),
		getFilePath("compiled", `sources`, "json")
	);

	const allTitles = Object.values(eventsData)
		.flat()
		.map((item) => item?.title)
		.filter(Boolean);

	let allUniqueTitles = [];
	let allUniqueTitles_jsonString = "";

	if (allTitles.length === 0) {
		logger.warn("No event titles extracted; skipping unique title generation");
		allUniqueTitles_jsonString = JSON.stringify({ uniqueEvents: [] });
	} else {
		logger.info("Stage: Generating unique event titles");
		const {
			rawJson,
			parsedJson: uniqueEventsSummary,
		} = await retryAsyncFunction(
			async (...args) => {
				const result = await generateAndParseJson(...args);
				const uniqueEvents = result?.parsedJson?.uniqueEvents;
				if (!Array.isArray(uniqueEvents)) {
					logger.warn("Unique events payload invalid", {
						parsedJsonType: typeof result?.parsedJson,
						rawJsonPreview: result?.rawJson?.slice(0, 200),
					});
					throw new Error("LLM returned an invalid unique events array");
				}
				return result;
			},
			RETRY_COUNT,
			JSON.stringify(allTitles),
			{
				systemMessage: PROMPT_TEMPLATES.GET_UNIQUE_EVENTS_SYSTEM_MESSAGE,
				responseSchema: {
					name: "UniqueEvents",
					schema: UNIQUE_EVENT_TITLES_RESPONSE_SCHEMA,
				},
				// temperature: 0,
			}
		);

		allUniqueTitles_jsonString = rawJson;
		allUniqueTitles = Array.isArray(uniqueEventsSummary?.uniqueEvents)
			? uniqueEventsSummary.uniqueEvents
			: [];

		logger.info(`A total of ${allUniqueTitles.length} unique events found.`, {
			allUniqueTitles,
		});
	}
	saveAsText(
		allUniqueTitles_jsonString,
		getFilePath("tmp", `unique_events`, "json")
	);

	let uniqueEventsData = [];
	let uniqueEventsData_jsonString = "";

	if (allUniqueTitles.length === 0) {
		logger.warn("No unique event titles available; skipping consolidation stage");
		uniqueEventsData_jsonString = JSON.stringify({ events: [] });
	} else {
		logger.info("Stage: Collating data for each unique event");
		const isGeminiPrimary = LLM_PREFERENCES.PRIMARY?.PROVIDER === "gemini";
		const useStructuredSchema = true;
		const allowGeminiTools = isGeminiPrimary && !useStructuredSchema;
		const toolGuidance = allowGeminiTools
			? "If you cannot confirm a field (especially datetime) from the provided data, use the available Google Search tool to look up authoritative sources, and attempt to resolve the missing information."
			: "";
		const {
			rawJson,
			parsedJson: uniqueEventsPayload,
		} = await retryAsyncFunction(
			generateAndParseJson,
			RETRY_COUNT,
			eventsData_combinedJsonString,
			{
				systemMessage:
					PROMPT_TEMPLATES.PREPARE_UNIQUE_EVENTS_DATA_SYSTEM_MESSAGE.replace(
						"{uniqueEvents}",
						`- ${allUniqueTitles.join("\n- ")}`
					).replace("{TOOL_GUIDANCE}", toolGuidance),
				tools:
					allowGeminiTools ? [{ google_search: {} }] : undefined,
				responseSchema: {
					name: "ConsolidatedEvents",
					schema: CONSOLIDATED_EVENTS_RESPONSE_SCHEMA,
				},
			}
		);

		uniqueEventsData_jsonString = rawJson;
		uniqueEventsData = Array.isArray(uniqueEventsPayload?.events)
			? uniqueEventsPayload.events
			: [];
	}

	saveAsText(
		uniqueEventsData_jsonString,
		getFilePath("tmp", `unique_events_data`, "json")
	);

	if (uniqueEventsData.length > 0) {
		logger.info("Stage: Generating structured datetimes");
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
				const { parsedJson: response_dateRange } = await retryAsyncFunction(
					generateAndParseJson,
					RETRY_COUNT,
					JSON.stringify([datetime]),
					{
						systemMessage:
							PROMPT_TEMPLATES.FORMAT_DATE_RANGE_SYSTEM_MESSAGE.replace(
								"{todayDate}",
								formatDate()
							),
						responseSchema: {
							name: "DateRanges",
							schema: DATE_RANGES_RESPONSE_SCHEMA,
						},
					}
				);
				const dateRanges = Array.isArray(response_dateRange?.dateRanges)
					? response_dateRange.dateRanges
					: [];
				const dateRange = dateRanges[0];

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

		logger.info("Stage: Structured datetimes generation completed");

		logger.info("Stage: Resolving event links and thumbnails");
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
		logger.info("Stage: Event link and thumbnail resolution completed");
	} else {
		logger.warn("No unique event data available; skipping date range and asset enrichment stages");
	}

	logger.info("Stage: Writing compiled artifacts to disk");

	saveAsText(
		JSON.stringify(uniqueEventsData),
		getFilePath("compiled", `events`, "json")
	);

	saveAsText(
		JSON.stringify(new Date().toISOString()),
		getFilePath("compiled", `generationTime`, "json")
	);

	const compiledDir = getDirectoryPath("compiled");
	try {
		logger.info("Stage: Uploading compiled artifacts to R2");
		await retryAsyncFunction(async () => {
			const success = await uploadAndUpdateLatest(compiledDir);
			if (!success) {
				throw new Error("Upload to R2 reported failure.");
			}
		}, 2);
		logger.info("Remote upload completed successfully.");
	} catch (error) {
		logger.error(
			"Unable to upload results to R2 after retries. Data remains available locally.",
			{ errorMessage: error?.message }
		);
	}

	return true;
}
