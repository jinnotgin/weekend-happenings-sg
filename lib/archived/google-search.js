/**
 * @deprecated Archived on 2026-11-14; retained for historical reference only.
 * Google Custom Search JSON API is closed to new customers and will be
 * discontinued on 2027-01-01. Existing customers must migrate before then:
 * https://developers.google.com/custom-search/v1/overview
 *
 * The active pipeline uses lib/brave-search.js for discovery, event links and
 * image candidates. Do not import this archived module: its GOOGLE_WEB_SEARCH_*
 * credential exports have been removed from config/secrets.js.
 */
import { nanoid } from "nanoid";
import {
	saveAs,
	getFilePath,
	getFilenameFromPath,
	sanitizeFilename,
} from "#lib/diskio.js";
import imageType, { minimumBytes } from "image-type";
import logger, { redactUrl } from "#lib/logger.js";
import {
	GOOGLE_WEB_SEARCH_API_KEY,
	GOOGLE_WEB_SEARCH_ENGINE_ID,
} from "#config/secrets.js";
import { IMAGE_SELECTION_CONFIG } from "#lib/constants.js";

function summarizeWebResponse(webResponse) {
	const items = Array.isArray(webResponse?.items) ? webResponse.items : [];
	const topItems = items.slice(0, 3).map((item) => ({
		title: item?.title ?? null,
		displayLink: item?.displayLink ?? null,
		link: item?.link ?? null,
	}));

	return {
		totalItems: items.length,
		searchTime: webResponse?.searchInformation?.formattedSearchTime ?? null,
		topItems,
	};
}

async function googleSearchSingapore(query, type = "web", pages = 1) {
	const endpointsMap = {
		web: "https://customsearch.googleapis.com/customsearch/v1",
	};
	if (!Object.keys(endpointsMap).includes(type)) {
		throw new Error("Invalid search type.");
	}

	const endpoint = endpointsMap[type];
	const baseParams = {
		cr: "countrySG",
		lr: "lang_en",
		safe: "active",
		key: GOOGLE_WEB_SEARCH_API_KEY,
		cx: GOOGLE_WEB_SEARCH_ENGINE_ID,
		q: query,
		num: 10, // Number of results per page (max 10 for free tier)
	};

	let combinedResult = null;

	try {
		for (let i = 0; i < pages; i++) {
			const params = {
				...baseParams,
				start: i * 10 + 1, // Start index for each page
			};

			const searchParams = new URLSearchParams(params);
			const url = `${endpoint}?${searchParams.toString()}`;

			const response = await fetch(url);

			if (!response.ok) {
				const bodyPreview = await readBodyPreview(response);
				logger.error(
					`googleSearchSingapore: Google Custom Search returned HTTP ${response.status} ${response.statusText}`,
					{ query, page: i + 1, status: response.status, bodyPreview }
				);
				throw new Error(
					`Google Custom Search returned HTTP ${response.status} ${response.statusText}`
				);
			}

			const data = await response.json();

			if (combinedResult === null) {
				combinedResult = data;
			} else {
				// Append items from subsequent pages
				combinedResult.items = combinedResult.items.concat(data.items || []);
			}
		}

		return combinedResult;
	} catch (error) {
		logger.error(`googleSearchSingapore: Search failed for "${query}": ${error.message}`, {
			query,
			errorMessage: error.message,
		});
		return null;
	}
}

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const IMAGE_FETCH_TIMEOUT_MS = 15000;

async function readBodyPreview(response, maxLength = 300) {
	try {
		return (await response.text()).slice(0, maxLength);
	} catch {
		return null;
	}
}

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
	// Perform a web search
	const webResponse = await googleSearchSingapore(query, "web", pages);

	logger.info(`Google Search results for: ${query}`, summarizeWebResponse(webResponse));

	// Extract all result's urls
	let urls =
		webResponse?.items?.map((item) => item?.link || null).filter(Boolean) || [];

	return urls;
}

async function getWebLinkAndSaveImage(query, options = {}) {
	const candidateFolderName = buildCandidateFolderName(query);
	const maxImages =
		typeof options?.maxImages === "number" && options.maxImages > 0
			? Math.min(
					options.maxImages,
					IMAGE_SELECTION_CONFIG.MAX_IMAGE_CANDIDATES
			  )
			: IMAGE_SELECTION_CONFIG.MAX_IMAGE_CANDIDATES;
	// Perform a web search
	const webResponse = await googleSearchSingapore(query, "web");

	logger.info(`Google Search results for: ${query}`, summarizeWebResponse(webResponse));

	// Extract the first web link
	let firstWebUrl = webResponse?.items?.[0]?.link || null;

	// Extract images from the images section of the response
	const images =
		webResponse?.items
			.map((item) => item?.pagemap?.cse_image?.[0]?.src || null)
			.filter((image) => image !== null) || [];

	// Attempt to save up to maxImages available images. A candidate failing is normal
	// (hotlink protection, SVG logos, ...), so skips are logged at debug and summarised below.
	const savedImages = [];
	const skipReasons = {};
	let attempted = 0;
	for (const imageUrl of images) {
		attempted += 1;
		try {
			const savedImage = await saveImage(imageUrl, candidateFolderName);
			savedImages.push({
				...savedImage,
				sourceUrl: imageUrl,
			});
			if (savedImages.length >= maxImages) {
				break;
			}
		} catch (error) {
			const reason = error instanceof ImageCandidateError ? error.reason : "unexpected_error";
			skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
			const meta = {
				query,
				imageUrl: redactUrl(imageUrl),
				reason,
				...(error?.details ?? {}),
			};
			if (reason === "unexpected_error") {
				logger.warn(`Image candidate failed unexpectedly: ${error?.message}`, { ...meta, error });
			} else {
				logger.debug(`Skipping image candidate: ${error.message}`, meta);
			}
		}
	}

	if (savedImages.length === 0) {
		logger.warn(`No usable image found for "${query}"`, {
			query,
			candidatesFound: images.length,
			candidatesTried: attempted,
			skipReasons,
		});
		throw new Error(
			`No images could be saved for "${query}" (${images.length} candidates; skipped: ${formatSkipReasons(skipReasons) || "none found"})`
		);
	}

	logger.info(`Stored ${savedImages.length} image candidate(s) for "${query}"`, {
		query,
		candidatesTried: attempted,
		skipReasons,
		candidateFolderName,
		candidateCount: savedImages.length,
	});

	return { firstWebUrl, savedImages };
}

function formatSkipReasons(skipReasons) {
	return Object.entries(skipReasons)
		.map(([reason, count]) => `${count} ${reason}`)
		.join(", ");
}

export { getSearchResultsUrls, getWebLinkAndSaveImage };
