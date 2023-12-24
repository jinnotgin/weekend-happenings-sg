import { JSDOM } from "jsdom";
import logger from "#lib/logger.js";

async function googleSearch(query) {
	const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

	try {
		const response = await fetch(url);
		const response_html = await response.text();
		const dom = new JSDOM(response_html);
		const document = dom.window.document;

		const elements = document.querySelectorAll("a h3");
		let results = [];

		elements.forEach((element) => {
			const title = element.textContent;
			const link = element
				.closest("a")
				.href.replace("/url?q=", "")
				.split("&")[0];

			results.push({ title, link });
		});

		return results;
	} catch (error) {
		console.error("Error fetching Google results:", error);
	}
}

async function googleImageSearch(query) {
	const url = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(
		query
	)}`;

	try {
		const response = await fetch(url);
		const response_html = await response.text();
		const dom = new JSDOM(response_html);
		const document = dom.window.document;

		const elements = document.querySelectorAll(".rg_i");
		let results = [];

		elements.forEach((element) => {
			const imageSource =
				element.getAttribute("data-src") ||
				element.getAttribute("data-lazy-src");
			const altText = element.getAttribute("alt");

			results.push({ altText, imageSource });
		});

		return results;
	} catch (error) {
		console.error("Error fetching Google Image results:", error);
	}
}

googleImageSearch("things to do in singapore this month")
	.then(console.log)
	.catch(console.error);

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
