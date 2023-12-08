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
		console.error("There has been a problem with your fetch operation:", error);
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

export { getFirstWebLink, getFirstImageLink };
