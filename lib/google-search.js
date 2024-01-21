import { nanoid } from "nanoid";
import { saveAs, getFilePath, getFilenameFromPath } from "#lib/diskio.js";
import imageType, { minimumBytes } from "image-type";
import logger from "#lib/logger.js";
import {
	GOOGLE_WEB_SEARCH_API_KEY,
	GOOGLE_WEB_SEARCH_ENGINE_ID,
} from "#config/secrets.js";

async function googleSearchSingapore(query, type = "web") {
	const endpointsMap = {
		web: "https://customsearch.googleapis.com/customsearch/v1",
	};
	if (!Object.keys(endpointsMap).includes(type)) {
		throw new Error("Invalid search type.");
	}

	const endpoint = endpointsMap[type];
	const params = {
		cr: "countrySG",
		lr: "lang_en",
		safe: "active",
		key: GOOGLE_WEB_SEARCH_API_KEY,
		cx: GOOGLE_WEB_SEARCH_ENGINE_ID,
		q: query,
	};

	try {
		const searchParams = new URLSearchParams(params);
		const url = `${endpoint}?${searchParams.toString()}`;

		const response = await fetch(url);

		// Check if the response is ok
		if (!response.ok) {
			logger.error("Response was not ok", { response });
			throw new Error("Network response was not ok");
		}

		// Parse the response as JSON
		const data = await response.json();
		return data;
	} catch (error) {
		// Handle any errors
		logger.error(
			`googleSearchSingapore: There has been a problem with your fetch operation: ${error.message}`,
			{ error }
		);
		return null;
	}
}

async function saveImage(imageUrl) {
	const response = await fetch(imageUrl);
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
	const webResponse = await googleSearchSingapore(query, "web");

	// Extract the first web link
	let firstWebUrl = webResponse?.items[0]?.link || null;

	// Extract images from the images section of the response
	let images =
		webResponse?.items.map(
			(item) => item?.pagemap?.cse_image[0]?.src || null
		) || [];

	logger.info(`Google Search results for: ${query}`, {
		webResponse,
	});

	// Attempt to save the first available image
	let savedImageFileName = null;
	for (const imageUrl of images) {
		try {
			savedImageFileName = await saveImage(imageUrl);
			break;
		} catch (error) {
			logger.error(`Error saving image: ${error.message}`, { error });
			continue;
		}
	}

	if (!savedImageFileName) {
		throw new Error("No images could be saved.");
	}

	return { firstWebUrl, savedImageFileName };
}

export { getWebLinkAndSaveImage };
