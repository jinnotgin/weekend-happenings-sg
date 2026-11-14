import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

import logger from "#lib/logger.js";
import {
	FIXED_URLS_TO_SCRAPE,
	SCRAPER_OPTIONS,
	SEARCH_TERM_FOR_EVENTS,
	BLACKLISTED_DOMAINS,
	PROMPT_TEMPLATES,
	RETRY_COUNT,
	LLM_TASK_PREFERENCES,
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
import { selectBestEventImage } from "#lib/image-selection.js";
import { locateVenuesForEvents, locateRegistryVenues } from "#lib/locate-venues.js";
import { uploadAndUpdateLatest, downloadObject } from "#lib/upload-r2.js";
import { createExecutorFromEnv } from "#lib/registry/executors.js";
import { Registry } from "#lib/registry/store.js";
import { resolveVenuesForEvents } from "#lib/registry/resolve-venues.js";
import {
	matchEventsToRegistry,
	reusableDateRange,
} from "#lib/registry/resolve-events.js";

const COMPILED_IMAGE_DIR = getDirectoryPath("compiled");
const UNIQUE_EVENT_BATCH_SIZE = 30;
// DATE_RANGES runs on paid Luna first (no meaningful RPM cap), so several events can be
// in flight at once. Keep modest: its last fallback is the free 3.5 Flash-Lite pool (15 RPM).
const DATE_RANGES_CONCURRENCY = 5;

// Runs `worker` over `items` with at most `limit` in flight; preserves no ordering guarantees
// for side effects but resolves once every item has finished.
async function mapWithConcurrency(items, limit, worker) {
	let nextIndex = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (nextIndex < items.length) {
			const item = items[nextIndex++];
			await worker(item);
		}
	});
	await Promise.all(runners);
}

async function persistCandidateThumbnail(savedImage) {
	if (!savedImage?.filename) {
		throw new Error("Candidate image is missing filename");
	}

	const sourcePath = savedImage.absolutePath;

	if (!sourcePath) {
		throw new Error("Unable to resolve source path for candidate image");
	}

	await fs.mkdir(COMPILED_IMAGE_DIR, { recursive: true });
	const targetPath = path.join(COMPILED_IMAGE_DIR, savedImage.filename);

	if (sourcePath !== targetPath) {
		await fs.copyFile(sourcePath, targetPath);
	}

	return savedImage.filename;
}

function chunkArray(array, size) {
	if (!Array.isArray(array) || size <= 0) {
		return [];
	}

	const chunks = [];
	for (let index = 0; index < array.length; index += size) {
		chunks.push(array.slice(index, index + size));
	}

	return chunks;
}

// Opens the venue/event registry (Cloudflare D1, or a local SQLite file when D1 is not
// configured). Returns null on failure: the run then continues in legacy mode, without
// stable IDs, rather than inventing IDs that would not be persisted.
async function openRegistry() {
	try {
		const { executor, durable } = await createExecutorFromEnv();
		const registry = await Registry.open({ executor, durable });
		logger.info("Registry opened", {
			backend: executor.describe(),
			venues: registry.venues.size,
			recentEvents: registry.events.size,
		});
		if (!durable && process.env.NODE_ENV === "production") {
			logger.warn(
				"Registry is using a local SQLite file: venue/event IDs will not survive this machine. Set D1_DATABASE_ID and CLOUDFLARE_API_TOKEN."
			);
		}
		return registry;
	} catch (error) {
		logger.error("Unable to open registry; continuing without stable IDs", {
			errorMessage: error?.message,
		});
		return null;
	}
}

function formatUniqueEventsForPrompt(events = []) {
	return events
		.map(({ title }) => `- ${title}`)
		.join("\n");
}

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
	logger.summary("Run started");
	logger.info("Stage: Data directory cleared");

	let registry = await openRegistry();
	// Consolidated event object -> registry record of the same event from an earlier run.
	let eventMatches = new Map();

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
					preferenceOrder:
						LLM_TASK_PREFERENCES.PARSE_EVENTS.ORDERED,
				}
			);

			saveAsText(eventsJsonStr, getFilePath("tmp", `json_${index}`, "txt"));

			let minifiedEventsJsonStr = eventsJsonStr;
			try {
				const parsedEventsJson = JSON.parse(eventsJsonStr);
				minifiedEventsJsonStr = JSON.stringify(parsedEventsJson);
			} catch (error) {
				logger.warn("Unable to minify parsed events JSON; using original output", {
					errorMessage: error?.message,
					sourceIndex: index,
				});
			}

			const parsedEvents = Array.isArray(parsedEventsPayload?.events)
				? parsedEventsPayload.events
				: [];

			eventsData[url] = parsedEvents;
			eventsData_combinedJsonString += `Source: ${index}\n${minifiedEventsJsonStr}\n===\n`;
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
	logger.summary("Stage: Scraping sources completed", {
		successfulSources: sources.length,
		failedSources: scrapeFailures,
	});
	saveAsText(
		JSON.stringify(sources),
		getFilePath("compiled", `sources`, "json")
	);

	const dedupeCandidates = Object.values(eventsData)
		.flat()
		.map((item) => {
			const title = typeof item?.title === "string" ? item.title.trim() : "";
			if (!title) {
				return null;
			}
			const hasDescription = typeof item?.description === "string";
			const description = hasDescription ? item.description.trim() : "";
			return {
				title,
				description: description.length > 0 ? description : null,
			};
		})
		.filter(Boolean);

	let uniqueEventSummaries = [];
	let uniqueEventSummaries_jsonString = "";

	if (dedupeCandidates.length === 0) {
		logger.warn(
			"No event candidates extracted; skipping unique event generation stage"
		);
		uniqueEventSummaries_jsonString = JSON.stringify({ uniqueEvents: [] });
	} else {
		logger.info("Stage: Generating unique event summaries");
		const {
			rawJson,
			parsedJson: uniqueEventsSummary,
		} = await retryAsyncFunction(
			async (...args) => {
				const result = await generateAndParseJson(...args);
				const uniqueEvents = result?.parsedJson?.uniqueEvents;
				const hasValidShape = Array.isArray(uniqueEvents)
					? uniqueEvents.every((event) =>
						event &&
						typeof event.title === "string" &&
						(typeof event.description === "string" || event.description === null)
					)
					: false;
				if (!hasValidShape) {
					logger.warn("Unique events payload invalid", {
						parsedJsonType: typeof result?.parsedJson,
						rawJsonPreview: result?.rawJson?.slice(0, 200),
					});
					throw new Error("LLM returned an invalid unique events array");
				}
				return result;
			},
			RETRY_COUNT,
			JSON.stringify(dedupeCandidates),
			{
				systemMessage: PROMPT_TEMPLATES.GET_UNIQUE_EVENTS_SYSTEM_MESSAGE,
				responseSchema: {
					name: "UniqueEvents",
					schema: UNIQUE_EVENT_TITLES_RESPONSE_SCHEMA,
				},
				preferenceOrder:
					LLM_TASK_PREFERENCES.UNIQUE_EVENTS.ORDERED,
				// temperature: 0,
			}
		);

		uniqueEventSummaries_jsonString = rawJson;
		uniqueEventSummaries = Array.isArray(uniqueEventsSummary?.uniqueEvents)
			? uniqueEventsSummary.uniqueEvents
			: [];

		logger.info(
			`A total of ${uniqueEventSummaries.length} unique events found.`,
			{
				uniqueEventSummaries,
			}
		);
	}
	saveAsText(
		uniqueEventSummaries_jsonString,
		getFilePath("tmp", `unique_events`, "json")
	);

	let uniqueEventsData = [];
	let uniqueEventsData_jsonString = "";

	if (uniqueEventSummaries.length === 0) {
		logger.warn("No unique event summaries available; skipping consolidation stage");
		uniqueEventsData_jsonString = JSON.stringify({ events: [] });
	} else {
		logger.info("Stage: Collating data for each unique event");
		// Structured output is always on, and free-tier Gemini has no Google Search
		// grounding, so the former Gemini google_search tool path was removed.
		const consolidationPreferences = LLM_TASK_PREFERENCES.CONSOLIDATE_EVENTS;
		const uniqueEventsBatches = chunkArray(
			uniqueEventSummaries,
			UNIQUE_EVENT_BATCH_SIZE
		);
		const batchRawResponses = [];
		const consolidatedEvents = [];

		for (let batchIndex = 0; batchIndex < uniqueEventsBatches.length; batchIndex++) {
			const batchSummaries = uniqueEventsBatches[batchIndex];
			logger.info(
				`Stage: Collating data for unique event batch ${batchIndex + 1}/${uniqueEventsBatches.length}`,
				{ batchSize: batchSummaries.length }
			);

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
							formatUniqueEventsForPrompt(batchSummaries)
						),
					responseSchema: {
						name: "ConsolidatedEvents",
						schema: CONSOLIDATED_EVENTS_RESPONSE_SCHEMA,
					},
					preferenceOrder: consolidationPreferences.ORDERED,
				}
			);

			const batchEvents = Array.isArray(uniqueEventsPayload?.events)
				? uniqueEventsPayload.events
				: [];

			if (!batchEvents.length) {
				logger.warn("No events returned from consolidation batch", {
					batchIndex,
					batchSize: batchSummaries.length,
				});
			}

			batchRawResponses.push({
				batchIndex,
				batchSize: batchSummaries.length,
				rawJson,
			});
			consolidatedEvents.push(...batchEvents);
		}

		logger.info("Unique event consolidation batches completed", {
			totalBatches: uniqueEventsBatches.length,
			totalEvents: consolidatedEvents.length,
		});

		uniqueEventsData_jsonString = JSON.stringify(batchRawResponses);
		uniqueEventsData = consolidatedEvents;
	}

	saveAsText(
		uniqueEventsData_jsonString,
		getFilePath("tmp", `unique_events_data`, "json")
	);

	if (uniqueEventsData.length > 0 && registry) {
		// Stable identities before enrichment, so enrichment can skip work for known
		// venues (location) and known events (date range, thumbnail).
		try {
			logger.info("Stage: Resolving venues against registry");
			await resolveVenuesForEvents(uniqueEventsData, registry);
			logger.info("Stage: Matching events against registry");
			eventMatches = await matchEventsToRegistry(uniqueEventsData, registry);
		} catch (error) {
			logger.error("Registry resolution failed; continuing without stable IDs", {
				errorMessage: error?.message,
				stack: error?.stack,
			});
			registry = null;
			eventMatches = new Map();
		}
	}

	if (uniqueEventsData.length > 0) {
		// The three enrichment stages below run CONCURRENTLY (Promise.allSettled at the end).
		// Each writes different fields of an event (locations / daterange / link+thumbnail)
		// and they mostly use different rate-limit pools: LOCATE_VENUES -> free 3.5 Flash-Lite
		// (15 RPM, self-paced), DATE_RANGES -> paid Luna (no meaningful RPM cap, so events run
		// in parallel), thumbnails -> web search + free 3.1 Flash-Lite (kept serial: the search
		// API and 15 RPM pool are the limits). Total time ~= the slowest stage, not the sum.
		// Only shared pool: DATE_RANGES' last fallback is free 3.5 Flash-Lite; per-minute 429s
		// there are absorbed by the Gemini client's wait-and-retry.

		// LOCATE_VENUES: one call per event (sequential, ~4s apart for the 15 RPM free tier).
		// Fills approximate_region/gps/nearest_mrt/google_maps_url on each location; on
		// failure the event is kept with those fields null.
		async function runLocateVenuesStage() {
			logger.info("Stage: Locating event venues", {
				eventCount: uniqueEventsData.length,
			});
			// With a registry only venues without stored coordinates cost an LLM call.
			const locateCalls = registry
				? await locateRegistryVenues(uniqueEventsData, registry)
				: await locateVenuesForEvents(uniqueEventsData);
			logger.info("Stage: Venue location completed", { locateCalls });
		}

		async function runDateRangesStage() {
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
						preferenceOrder:
							LLM_TASK_PREFERENCES.DATE_RANGES.ORDERED,
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
					`Attempt ${attempt + 1
					}: Received null daterange for datetime: ${datetime}. Retrying...`
				);
			}

			throw new Error(
				`Failed to generate valid daterange for datetime: ${datetime} after ${retryCount} attempts`
			);
		}

		let reusedDateRanges = 0;
		await mapWithConcurrency(uniqueEventsData, DATE_RANGES_CONCURRENCY, async (item) => {
			const reusable = reusableDateRange(item, eventMatches.get(item));
			if (reusable) {
				item.daterange = reusable;
				reusedDateRanges += 1;
				return;
			}
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
		});

		logger.info("Stage: Structured datetimes generation completed", { reusedDateRanges });
		}

		async function runThumbnailsStage() {
		logger.info("Stage: Resolving event links and thumbnails");
		let reusedThumbnails = 0;
		for (let item of uniqueEventsData) {
			const { title = "", location = "", datetime = "" } = item;
			// Known event: copy last run's thumbnail from R2 instead of searching again.
			const stored = eventMatches.get(item);
			if (stored?.thumbnail && stored?.thumbnailKey) {
				const reused = await downloadObject(
					stored.thumbnailKey,
					path.join(COMPILED_IMAGE_DIR, stored.thumbnail)
				);
				if (reused) {
					item.link = stored.link ?? null;
					item.thumbnail = stored.thumbnail;
					reusedThumbnails += 1;
					continue;
				}
			}
			try {
				const searchQuery = `"${title} singapore`;
				logger.info(`Getting link and thumbnails for ${title}`);

				const { firstWebUrl, savedImages = [] } = await retryAsyncFunction(
					getWebLinkAndSaveImage,
					RETRY_COUNT,
					searchQuery
				);

				logger.info(`Retrieved link and ${savedImages.length} image candidates for ${title}`, {
					firstWebUrl,
				});

				let selectionMetadata = null;
				let selectedImageIndex =
					Array.isArray(savedImages) && savedImages.length > 0 ? 1 : null;

				if (Array.isArray(savedImages) && savedImages.length > 0) {
					selectionMetadata = await selectBestEventImage({
						eventTitle: title,
						eventDescription: item?.description ?? "",
						savedImages,
					});

					if (
						selectionMetadata?.bestImageIndex &&
						savedImages[selectionMetadata.bestImageIndex - 1]
					) {
						selectedImageIndex = selectionMetadata.bestImageIndex;
					} else if (selectionMetadata?.bestImageIndex) {
						logger.warn("Image selection returned out-of-range index; using fallback", {
							requestedIndex: selectionMetadata.bestImageIndex,
							candidateCount: savedImages.length,
							eventTitle: title,
						});
						selectedImageIndex =
							Array.isArray(savedImages) && savedImages.length > 0 ? 1 : null;
					}
				}

				const selectedImage =
					typeof selectedImageIndex === "number"
						? savedImages[selectedImageIndex - 1] ?? null
						: null;

				let selectedThumbnail = null;
				if (selectedImage) {
					try {
						selectedThumbnail = await persistCandidateThumbnail(selectedImage);
					} catch (error) {
						logger.error(`Unable to persist thumbnail for ${title}`, {
							errorMessage: error?.message,
						});
					}
				}

				item.link = firstWebUrl;
				item.thumbnail = selectedThumbnail;

				if (selectionMetadata) {
					logger.info(`Thumbnail selected for ${title}`, {
						selectedThumbnail,
						bestImageIndex: selectionMetadata.bestImageIndex,
						justification: selectionMetadata.justification,
						provider: selectionMetadata.provider,
						model: selectionMetadata.model,
					});
					if (!selectedThumbnail) {
						logger.warn(`Unable to retain selected thumbnail for ${title}`);
					}
				} else {
					if (selectedThumbnail) {
						logger.warn(`Falling back to first available thumbnail for ${title}`);
					} else {
						logger.warn(`No thumbnail available for ${title}`);
					}
				}
			} catch (error) {
				logger.error(
					`Unable to fetch link / image for ${title}: ${error.message}`
				);
			}
		}
		logger.info("Stage: Event link and thumbnail resolution completed", { reusedThumbnails });
		}

		const stageNames = ["LOCATE_VENUES", "DATE_RANGES", "THUMBNAILS"];
		const stageResults = await Promise.allSettled([
			runLocateVenuesStage(),
			runDateRangesStage(),
			runThumbnailsStage(),
		]);
		stageResults.forEach((result, index) => {
			if (result.status === "rejected") {
				logger.error(`Enrichment stage ${stageNames[index]} failed`, {
					errorMessage: result.reason?.message,
				});
			}
		});
	} else {
		logger.warn("No unique event data available; skipping date range and asset enrichment stages");
	}

	if (registry) {
		for (const item of uniqueEventsData) {
			const record = registry.upsertEvent(item, eventMatches.get(item)?.id ?? null);
			item.id = record.id;
			item.first_seen = record.firstSeen;
		}
		saveAsText(
			JSON.stringify(registry.exportPublicVenues()),
			getFilePath("compiled", `venues`, "json")
		);
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
	let uploadResult = null;
	try {
		logger.info("Stage: Uploading compiled artifacts to R2");
		uploadResult = await retryAsyncFunction(async () => {
			const result = await uploadAndUpdateLatest(compiledDir);
			if (!result) {
				throw new Error("Upload to R2 reported failure.");
			}
			return result;
		}, 2);
		logger.info("Remote upload completed successfully.");
		logger.summary("Remote upload completed successfully.");
	} catch (error) {
		logger.error(
			"Unable to upload results to R2 after retries. Data remains available locally.",
			{ errorMessage: error?.message }
		);
		// Keep going so the run summary is logged, but flag the run as failed.
		process.exitCode = 1;
	}

	if (registry) {
		try {
			logger.info("Stage: Saving registry");
			if (uploadResult?.archiveFolder) {
				registry.setThumbnailKeys((filename) => `${uploadResult.archiveFolder}/${filename}`);
			}
			const statementCount = await retryAsyncFunction(() => registry.commit(), 2);
			logger.summary("Registry saved", { statementCount, ...registry.stats });
		} catch (error) {
			// IDs in this run's events.json are not persisted: next run may assign new ones.
			logger.error("Unable to save registry", { errorMessage: error?.message });
			process.exitCode = 1;
		}
	}

	logger.summary("Run completed", {
		uniqueEvents: uniqueEventsData.length,
		scrapeFailures,
	});
	return true;
}
