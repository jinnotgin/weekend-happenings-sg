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
import { uploadAndUpdateLatest } from "#lib/upload-r2.js";

const COMPILED_IMAGE_DIR = getDirectoryPath("compiled");
const UNIQUE_EVENT_BATCH_SIZE = 30;
const PIPELINE_PHASES = [
	"scrape",
	"unique",
	"consolidate",
	"enrich",
	"compile",
];

function getPhaseIndex(phase) {
	return PIPELINE_PHASES.indexOf(phase);
}

function shouldRunPhase(startPhase, phase) {
	return getPhaseIndex(phase) >= getPhaseIndex(startPhase);
}

function normalizeStartPhase(rawPhase) {
	if (!rawPhase) {
		return "scrape";
	}

	const normalized = String(rawPhase).trim().toLowerCase();
	return normalized === "beginning" ? "scrape" : normalized;
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

async function loadParsedEventsFromTmpFiles() {
	const tmpDir = getDirectoryPath("tmp");
	const filenames = await fs.readdir(tmpDir);
	const sourceJsonFilenames = filenames
		.filter((name) => /^json_\d+\.txt$/.test(name))
		.sort((a, b) => {
			const numberA = Number(a.match(/\d+/)?.[0] ?? 0);
			const numberB = Number(b.match(/\d+/)?.[0] ?? 0);
			return numberA - numberB;
		});

	const eventsData = {};
	let eventsDataCombinedJsonString = "";
	let validSourceCount = 0;

	for (let index = 0; index < sourceJsonFilenames.length; index++) {
		const filename = sourceJsonFilenames[index];
		const filePath = path.join(tmpDir, filename);
		const fileContent = await fs.readFile(filePath, "utf-8");

		try {
			const parsedSource = JSON.parse(fileContent);
			const parsedEvents = Array.isArray(parsedSource?.events)
				? parsedSource.events
				: [];
			const sourceKey = `tmp://${filename}`;
			eventsData[sourceKey] = parsedEvents;
			eventsDataCombinedJsonString += `Source: ${index}\n${JSON.stringify(parsedSource)}\n===\n`;
			validSourceCount += 1;
		} catch (error) {
			logger.warn("Skipping invalid tmp source JSON file", {
				filename,
				errorMessage: error?.message,
			});
		}
	}

	if (validSourceCount === 0) {
		throw new Error(
			"No valid source JSON files found in data/tmp. Run with --start-phase scrape first."
		);
	}

	return { eventsData, eventsDataCombinedJsonString, validSourceCount };
}

async function loadUniqueEventSummariesFromTmp() {
	const uniqueEventsPath = getFilePath("tmp", "unique_events", "json");
	const fileContent = await fs.readFile(uniqueEventsPath, "utf-8");
	const parsedUniqueEvents = JSON.parse(fileContent);
	return Array.isArray(parsedUniqueEvents?.uniqueEvents)
		? parsedUniqueEvents.uniqueEvents
		: [];
}

async function loadUniqueEventsDataFromTmp() {
	const uniqueEventsDataPath = getFilePath("tmp", "unique_events_data", "json");
	const fileContent = await fs.readFile(uniqueEventsDataPath, "utf-8");
	const parsed = JSON.parse(fileContent);

	if (Array.isArray(parsed)) {
		const consolidatedEvents = [];
		for (const batch of parsed) {
			try {
				const parsedBatch = JSON.parse(batch?.rawJson ?? "{}");
				const batchEvents = Array.isArray(parsedBatch?.events)
					? parsedBatch.events
					: [];
				consolidatedEvents.push(...batchEvents);
			} catch (error) {
				logger.warn("Skipping invalid consolidation batch rawJson", {
					errorMessage: error?.message,
				});
			}
		}
		return consolidatedEvents;
	}

	if (Array.isArray(parsed?.events)) {
		return parsed.events;
	}

	return [];
}

async function loadCompiledEventsFromDisk() {
	const compiledEventsPath = getFilePath("compiled", "events", "json");
	const fileContent = await fs.readFile(compiledEventsPath, "utf-8");
	const parsedCompiledEvents = JSON.parse(fileContent);
	return Array.isArray(parsedCompiledEvents) ? parsedCompiledEvents : [];
}

export async function main({ startPhase: rawStartPhase } = {}) {
	const startPhase = normalizeStartPhase(rawStartPhase);
	if (getPhaseIndex(startPhase) === -1) {
		throw new Error(
			`Invalid start phase "${startPhase}". Valid phases: ${PIPELINE_PHASES.join(", ")}`
		);
	}

	logger.info("Pipeline starting", { startPhase });

	if (startPhase === "scrape") {
		await clearDataDirectory();
		logger.info("Stage: Data directory cleared");
	} else {
		logger.info("Stage: Data directory clear skipped", {
			reason: "Resuming from later phase",
		});
	}

	let eventsData_combinedJsonString = "";
	const eventsData = {};
	if (shouldRunPhase(startPhase, "scrape")) {
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
		saveAsText(
			JSON.stringify(sources),
			getFilePath("compiled", `sources`, "json")
		);
	} else {
		logger.info("Stage: Scrape skipped; loading source JSON from data/tmp");
		const loaded = await loadParsedEventsFromTmpFiles();
		Object.assign(eventsData, loaded.eventsData);
		eventsData_combinedJsonString = loaded.eventsDataCombinedJsonString;
		logger.info("Stage: Loaded source JSON from disk", {
			sourceCount: loaded.validSourceCount,
		});
	}

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

	if (shouldRunPhase(startPhase, "unique")) {
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
	} else {
		logger.info("Stage: Unique event generation skipped; loading from disk");
		uniqueEventSummaries = await loadUniqueEventSummariesFromTmp();
		logger.info("Stage: Loaded unique event summaries", {
			totalUniqueEvents: uniqueEventSummaries.length,
		});
	}

	let uniqueEventsData = [];
	let uniqueEventsData_jsonString = "";

	if (shouldRunPhase(startPhase, "consolidate")) {
		if (uniqueEventSummaries.length === 0) {
			logger.warn("No unique event summaries available; skipping consolidation stage");
			uniqueEventsData_jsonString = JSON.stringify({ events: [] });
		} else {
			logger.info("Stage: Collating data for each unique event");
			const consolidationPreferences = LLM_TASK_PREFERENCES.CONSOLIDATE_EVENTS;
			const isGeminiPrimary = consolidationPreferences.PRIMARY?.PROVIDER === "gemini";
			const useStructuredSchema = true;
			const allowGeminiTools = isGeminiPrimary && !useStructuredSchema;
			const toolGuidance = allowGeminiTools
				? "If you cannot confirm a field (especially datetime) from the provided data, use the available Google Search tool to look up authoritative sources, and attempt to resolve the missing information."
				: "";
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
							).replace("{TOOL_GUIDANCE}", toolGuidance),
						tools:
							allowGeminiTools ? [{ google_search: {} }] : undefined,
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
	} else {
		logger.info("Stage: Consolidation skipped; loading consolidated data from disk");
		uniqueEventsData = await loadUniqueEventsDataFromTmp();
		logger.info("Stage: Loaded consolidated events", {
			totalEvents: uniqueEventsData.length,
		});
	}

	if (shouldRunPhase(startPhase, "enrich")) {
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
			logger.info("Stage: Event link and thumbnail resolution completed");
		} else {
			logger.warn("No unique event data available; skipping date range and asset enrichment stages");
		}
	} else {
		logger.info("Stage: Enrichment skipped");
		if (startPhase === "compile") {
			uniqueEventsData = await loadCompiledEventsFromDisk();
			logger.info("Stage: Loaded compiled events from disk", {
				totalEvents: uniqueEventsData.length,
			});
		}
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
