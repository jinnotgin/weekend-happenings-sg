import { nanoid } from "nanoid";
import {
	saveAs,
	getFilePath,
	getFilenameFromPath,
	sanitizeFilename,
} from "#lib/diskio.js";
import imageType, { minimumBytes } from "image-type";
import logger from "#lib/logger.js";
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
				logger.error("Response was not ok", { response });
				throw new Error("Network response was not ok");
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
		logger.error(
			`googleSearchSingapore: There has been a problem with your fetch operation: ${error.message}`,
			{ error }
		);
		return null;
	}
}

async function saveImage(imageUrl, folderName = "compiled") {
	const response = await fetch(imageUrl);
	const arrayBuffer = await response.arrayBuffer();
	const imageBuffer = Buffer.from(arrayBuffer);

	const type = await imageType(imageBuffer);

	const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

	if (!type || !allowedMimeTypes.has(type.mime)) {
		throw new Error("Unsupported image type; only jpeg, png, and webp are allowed");
	}

	const uniqueFileName = nanoid();
	const fileExtension = type.ext;
	const filePath = getFilePath(folderName, uniqueFileName, fileExtension);
	saveAs(imageBuffer, filePath);
	logger.info(`Image saved to ${filePath}`);
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

	// Attempt to save up to maxImages available images
		const savedImages = [];
		for (const imageUrl of images) {
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
				logger.error(`Error saving image: ${error.message}`, { error });
				continue;
			}
		}

	if (savedImages.length === 0) {
		throw new Error("No images could be saved.");
	}

	logger.info("Stored image candidates", {
		query,
		candidateFolderName,
		candidateCount: savedImages.length,
	});

	return { firstWebUrl, savedImages };
}

export { getSearchResultsUrls, getWebLinkAndSaveImage };
