import { nanoid } from "nanoid";
import {
	saveAs,
	getFilePath,
	getFilenameFromPath,
	sanitizeFilename,
} from "#lib/diskio.js";
import imageType from "image-type";
import logger, { redactUrl } from "#lib/logger.js";
import { BRAVE_SEARCH_API_KEY } from "#config/secrets.js";
import { IMAGE_SELECTION_CONFIG } from "#lib/constants.js";

const SEARCH_TIMEOUT_MS = 15000;
const REQUEST_INTERVAL_MS = 1100;
let searchQueue = Promise.resolve();
let nextRequestAt = 0;

// Discovery queries run concurrently. Pace all web/image requests through one queue
// to stay within a 1-request/second subscription, including retries after failures.
function braveSearchSingapore(query, type = "web", params = {}) {
	const operation = searchQueue.then(async () => {
		const delay = nextRequestAt - Date.now();
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
		const url = new URL(`https://api.search.brave.com/res/v1/${type}/search`);
		url.search = new URLSearchParams({
			q: query,
			country: "SG",
			search_lang: "en",
			safesearch: "strict",
			...params,
		}).toString();
		const response = await fetch(url, {
			headers: { Accept: "application/json", "X-Subscription-Token": BRAVE_SEARCH_API_KEY },
			signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			// Do not log request headers or response bodies that might echo credentials.
			throw new Error(`Brave ${type} search returned HTTP ${response.status} ${response.statusText}`);
		}
		const data = await response.json();
		if (data?.error) throw new Error(`Brave ${type} search returned an error`);
		const results = type === "web" ? data?.web?.results : data?.results;
		if (results != null && !Array.isArray(results)) {
			throw new Error(`Brave ${type} search returned invalid results`);
		}
		logger.info(`Brave ${type} search results for: ${query}`, {
			totalItems: results?.length ?? 0,
			topItems: (results ?? []).slice(0, 3).map(({ title, url }) => ({ title, url })),
		});
		return data;
	});
	searchQueue = operation.catch(() => {});
	return operation;
}

function isHttpUrl(value) {
	try {
		return ["http:", "https:"].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const IMAGE_FETCH_TIMEOUT_MS = 15000;

// Thrown for an image candidate we skip on purpose. `reason` is a short machine-friendly
// tag (http_error, not_an_image, unsupported_format, ...) used in the per-query summary.
class ImageCandidateError extends Error {
	constructor(reason, message, details = {}) {
		super(message);
		this.name = "ImageCandidateError";
		this.reason = reason;
		this.details = details;
	}
}

async function saveImage(imageUrl, folderName = "compiled") {
	let response;
	try {
		response = await fetch(imageUrl, {
			signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
		});
	} catch (error) {
		const timedOut = error?.name === "TimeoutError";
		throw new ImageCandidateError(
			timedOut ? "timeout" : "fetch_failed",
			timedOut
				? `Download timed out after ${IMAGE_FETCH_TIMEOUT_MS / 1000}s`
				: `Download failed: ${error?.cause?.code ?? error?.message}`
		);
	}

	const contentType = response.headers.get("content-type");
	if (!response.ok) {
		throw new ImageCandidateError(
			"http_error",
			`Download returned HTTP ${response.status} ${response.statusText}`,
			{ httpStatus: response.status, contentType }
		);
	}

	const arrayBuffer = await response.arrayBuffer();
	const imageBuffer = Buffer.from(arrayBuffer);

	const type = await imageType(imageBuffer);

	if (!type) {
		throw new ImageCandidateError(
			"not_an_image",
			`Downloaded content is not a recognised image (content-type: ${contentType ?? "none"})`,
			{ httpStatus: response.status, contentType, sizeBytes: imageBuffer.length }
		);
	}

	if (!ALLOWED_IMAGE_MIME_TYPES.has(type.mime)) {
		throw new ImageCandidateError(
			"unsupported_format",
			`Image is ${type.mime}; only jpeg, png and webp are allowed`,
			{ httpStatus: response.status, contentType, detectedMime: type.mime, sizeBytes: imageBuffer.length }
		);
	}

	const uniqueFileName = nanoid();
	const fileExtension = type.ext;
	const filePath = getFilePath(folderName, uniqueFileName, fileExtension);
	saveAs(imageBuffer, filePath);
	logger.debug(`Image saved to ${filePath}`);
	return {
		filename: getFilenameFromPath(filePath),
		absolutePath: filePath,
		folderName,
	};
}

function buildCandidateFolderName(query = "") {
	const sanitizedQuery = sanitizeFilename(query) || "search";
	const slug = sanitizedQuery
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 50)
		.replace(/^-+|-+$/g, "");

	return `image-candidates/${slug || "search"}-${nanoid(6)}`;
}

async function getSearchResultsUrls(query, pages = 1) {
	if (!Number.isInteger(pages) || pages < 1 || pages > 10) {
		throw new Error("Search pages must be an integer between 1 and 10");
	}
	const urls = new Set();
	for (let offset = 0; offset < pages; offset++) {
		const data = await braveSearchSingapore(query, "web", {
			count: 10, offset, result_filter: "web",
		});
		for (const result of data.web?.results ?? []) {
			if (isHttpUrl(result.url)) urls.add(result.url);
		}
		if (!data.query?.more_results_available) break;
	}
	return [...urls];
}

async function getWebLinkAndSaveImage(query, options = {}) {
	const candidateFolderName = buildCandidateFolderName(query);
	const maxImages = Number.isInteger(options.maxImages) && options.maxImages > 0
		? Math.min(options.maxImages, IMAGE_SELECTION_CONFIG.MAX_IMAGE_CANDIDATES)
		: IMAGE_SELECTION_CONFIG.MAX_IMAGE_CANDIDATES;
	const webResponse = await braveSearchSingapore(query, "web", { count: 10, result_filter: "web" });
	const webResults = webResponse.web?.results ?? [];
	const firstWebUrl = webResults.find((item) => isHttpUrl(item.url))?.url ?? null;
	const savedImages = [];
	const attemptedUrls = new Set();
	const skipReasons = {};

	async function saveCandidates(candidates) {
		for (const { imageUrl, pageUrl } of candidates) {
			if (savedImages.length >= maxImages) break;
			if (!isHttpUrl(imageUrl) || attemptedUrls.has(imageUrl)) continue;
			attemptedUrls.add(imageUrl);
			try {
				const savedImage = await saveImage(imageUrl, candidateFolderName);
				savedImages.push({ ...savedImage, sourceUrl: imageUrl, pageUrl });
			} catch (error) {
				const reason = error instanceof ImageCandidateError ? error.reason : "unexpected_error";
				skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
				logger.debug(`Skipping image candidate: ${error.message}`, {
					query, imageUrl: redactUrl(imageUrl), reason, ...(error?.details ?? {}),
				});
			}
		}
	}

	// Prefer images associated with ranked event pages before broad image search.
	await saveCandidates(webResults.flatMap((item) => item.thumbnail?.logo ? [] : [
		{ imageUrl: item.thumbnail?.original ?? item.thumbnail?.src, pageUrl: item.url },
	]));
	if (savedImages.length < maxImages) {
		try {
			const imageResponse = await braveSearchSingapore(query, "images", { count: 20, spellcheck: false });
			await saveCandidates((imageResponse.results ?? []).map((item) => ({
				imageUrl: item.properties?.url ?? item.thumbnail?.src,
				pageUrl: item.url,
			})));
		} catch (error) {
			logger.warn(`Brave image search failed for "${query}": ${error.message}`, { query });
			// Keep a useful event link even if the image-search service is unavailable.
			// With neither a link nor an image, let the caller retry the failure.
			if (!firstWebUrl && savedImages.length === 0) throw error;
		}
	}

	logger.info(`Stored ${savedImages.length} image candidate(s) for "${query}"`, {
		query, candidatesTried: attemptedUrls.size, skipReasons,
		candidateFolderName, candidateCount: savedImages.length,
	});
	if (savedImages.length === 0) {
		logger.warn(`No usable image found for "${query}" (${formatSkipReasons(skipReasons) || "none found"})`);
	}
	// A missing image must not discard a valid event link or repeat empty searches.
	return { firstWebUrl, savedImages };
}

function formatSkipReasons(skipReasons) {
	return Object.entries(skipReasons)
		.map(([reason, count]) => `${count} ${reason}`)
		.join(", ");
}

export { getSearchResultsUrls, getWebLinkAndSaveImage };
