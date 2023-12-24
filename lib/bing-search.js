import { nanoid } from "nanoid";
import { saveAs, getFilePath, getFilenameFromPath } from "#lib/diskio.js";
import logger from "#lib/logger.js";
import { JSDOM } from "jsdom";

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
		// Construct the headers
		const headers = {
			"Ocp-Apim-Subscription-Key": process.env.BING_SEARCH_API_KEY,
		};

		// Make the HTTP GET request using fetch
		const response = await fetch(
			`${endpoint}?q=${encodeURIComponent(query)}&mkt=${market}`,
			{ headers }
		);

		// Check if the response is ok
		if (!response.ok) {
			throw new Error("Network response was not ok");
		}

		// Parse the response as JSON
		const data = await response.json();
		return data;
	} catch (error) {
		// Handle any errors
		logger.error(
			`bingSearchSingapore: There has been a problem with your fetch operation: ${error.message}`,
			{ error }
		);
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

async function fetchOgImage(url) {
	// TODO need to add support for relative links
	try {
		const response = await fetch(url);
		const response_html = await response.text();
		const dom = new JSDOM(response_html);
		const document = dom.window.document;

		const metaOgImage = document.querySelector("meta[property='og:image']");

		if (metaOgImage && metaOgImage.hasAttribute("content")) {
			const imageUrl = metaOgImage.getAttribute("content");
			const extension = imageUrl.split(".").pop();

			if (extension === "jpg" || extension === "jpeg" || extension === "png") {
				logger.info("Using OG Image from", url);
				return imageUrl;
			}
		}

		return false;
	} catch (error) {
		console.error("Error fetching URL:", error);
		return false;
	}
}

async function saveImage(imageUrl, fileExtension) {
	const image = await fetch(imageUrl);
	const arrayBuffer = await image.arrayBuffer();
	const imageBuffer = Buffer.from(arrayBuffer);
	const uniqueFileName = nanoid();
	const filePath = getFilePath("compiled", uniqueFileName, fileExtension);
	saveAs(imageBuffer, filePath);
	logger.info(`Image saved to ${filePath}`);
	return getFilenameFromPath(filePath);
}

async function getWebLinkAndSaveImage(query) {
	// Perform a web search
	const webResponse = await bingSearchSingapore(query, "web");

	// Extract the first web link
	let firstWebUrl = webResponse.webPages?.value?.[0]?.url || null;

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
			const fileExtension = imageInfo.encodingFormat || "jpg"; // Default to 'jpg' if encodingFormat is not available
			savedImageFileName = await saveImage(imageUrl, fileExtension);
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
