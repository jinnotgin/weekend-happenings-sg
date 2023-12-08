async function googleSearch(query, type = "web", location = "Singapore") {
	const baseUrl = "http://api.serpstack.com/search";

	try {
		const requestUrl = `${baseUrl}?access_key=${
			process.env.SERPSTACK_API_KEY
		}&query=${encodeURIComponent(query)}&type=${type}&location=${location}`;
		const response = await fetch(requestUrl);

		if (!response.ok) {
			throw new Error("Network response was not ok");
		}

		return await response.json();
	} catch (error) {
		console.error("There has been a problem with your fetch operation:", error);
		return null;
	}
}

async function getFirstResultLink(query) {
	try {
		const data = await googleSearch(query, "web");
		console.log({ query, data });

		// Check if there are any results
		if (!data || !data.organic_results || data.organic_results.length === 0) {
			throw new Error("No search results found");
		}

		// Return the link of the first search result
		return data.organic_results[0].url;
	} catch (error) {
		// Handle any errors
		console.error("Error getting first result link:", error);
		return null; // Or handle the error as needed
	}
}

async function getFirstImageLink(query) {
	try {
		const data = await googleSearch(query, "images");
		console.log({ query, data });

		if (!data || !data.image_results || data.image_results.length === 0) {
			throw new Error("No image results found");
		}

		return data.image_results[0].image_url;
	} catch (error) {
		console.error("Error getting first image link:", error);
		return null;
	}
}

export { getFirstResultLink, getFirstImageLink };
