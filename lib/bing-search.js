import { nanoid } from "nanoid";
import { saveAs, getFilePath, getFilenameFromPath } from "#lib/diskio.js";
import imageType, { minimumBytes } from "image-type";
import logger from "#lib/logger.js";
import { BING_SEARCH_API_KEY } from "#config/secrets.js";

async function bingSearchSingapore(query, type = "web") {
	const endpointsMap = {
		web: "https://api.bing.microsoft.com/v7.0/search",
		images: "https://api.bing.microsoft.com/v7.0/images/search",
	};
	if (!Object.keys(endpointsMap).includes(type)) {
		throw new Error("Invalid search type.");
	}

	const endpoint = endpointsMap[type];
	const market = "en-SG"; // Specify the market as Singapore

	try {
		const resolvedApiKey = BING_SEARCH_API_KEY ?? process.env.BING_SEARCH_API_KEY;

		if (!resolvedApiKey) {
			throw new Error("BING_SEARCH_API_KEY is not configured.");
		}

		// Construct the headers
		const headers = {
			"Ocp-Apim-Subscription-Key": resolvedApiKey,
		};

		// Make the HTTP GET request using fetch
		const response = await fetch(
			`${endpoint}?q=${encodeURIComponent(query)}&mkt=${market}`,
			{ headers }
		);

		// Check if the response is ok
		if (!response.ok) {
			logger.error(`bingSearchSingapore: Bing returned HTTP ${response.status} ${response.statusText}`, {
				query,
				type,
				status: response.status,
			});
			throw new Error(`Bing search returned HTTP ${response.status} ${response.statusText}`);
		}

		// Parse the response as JSON
		const data = await response.json();
		return data;
	} catch (error) {
		// Handle any errors
		logger.error(`bingSearchSingapore: Search failed for "${query}": ${error.message}`, {
			query,
			type,
			errorMessage: error.message,
		});
		return null;
	}
}

async function getFirstWebLink(query) {
	const bingApiResponse = await bingSearchSingapore(query, "web");

	// Initialize variables to store the first web result
	let firstWebUrl = null;

	// Check if the response has webPages, and extract the relevant data
	if (
		bingApiResponse.webPages &&
		bingApiResponse.webPages.value &&
		bingApiResponse.webPages.value.length > 0
	) {
		firstWebUrl = bingApiResponse.webPages.value[0].url;
	}

	return firstWebUrl;
}

async function getFirstImageLink(query) {
	const bingApiResponse = await bingSearchSingapore(query, "images");

	// Initialize variables to store the first image URL
	let firstImageUrl = null;

	// Check if the response has images, and extract the relevant data
	if (
		bingApiResponse &&
		bingApiResponse.value &&
		bingApiResponse.value.length > 0
	) {
		firstImageUrl = bingApiResponse.value[0].contentUrl;
	}

	return firstImageUrl;
}

async function saveImage(imageUrl) {
	const response = await fetch(imageUrl);
	if (!response.ok) {
		throw new Error(`Download returned HTTP ${response.status} ${response.statusText}`);
	}
	const arrayBuffer = await response.arrayBuffer();
	const imageBuffer = Buffer.from(arrayBuffer);

	const type = await imageType(imageBuffer);

	if (!type || !type.mime.startsWith("image/")) {
		throw new Error("Could not determine image type / URL is not an image");
	}

	const uniqueFileName = nanoid();
	const fileExtension = type.ext;
	const filePath = getFilePath("compiled", uniqueFileName, fileExtension);
	saveAs(imageBuffer, filePath);
	logger.info(`Image saved to ${filePath}`);
	return getFilenameFromPath(filePath);
}

async function getWebLinkAndSaveImage(query) {
	// Perform a web search
	const webResponse = await bingSearchSingapore(query, "web");

	// Extract the first web link
	let firstWebUrl = webResponse?.webPages?.value?.[0]?.url || null;

	// Extract images from the images section of the response
	let images = webResponse?.images?.value || [];

	// If no images found, perform an image-only search
	if (images.length === 0) {
		const imageResponse = await bingSearchSingapore(query, "images");
		images = imageResponse?.value || [];
	}

	// Attempt to save the first available image
	let savedImageFileName = null;
	for (const imageInfo of images) {
		try {
			const imageUrl = imageInfo.contentUrl;
			// const fileExtension = imageInfo.encodingFormat || "jpg"; // Default to 'jpg' if encodingFormat is not available
			savedImageFileName = await saveImage(imageUrl);
			break;
		} catch (error) {
			logger.warn(`Skipping image candidate: ${error.message}`, {
				query,
				imageUrl: imageInfo?.contentUrl,
			});
			continue;
		}
	}

	if (!savedImageFileName) {
		throw new Error("No images could be saved.");
	}

	return { firstWebUrl, savedImageFileName };
}

export { getWebLinkAndSaveImage };
