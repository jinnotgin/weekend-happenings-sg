// import { JSDOM } from "jsdom";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import logger from "#lib/logger.js";

// async function fetchHtml(url) {
// 	const headers = {
// 		"User-Agent":
// 			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
// 	};
// 	const response = await fetch(url, { headers });
// 	return await response.text();
// }

// function extractTextWithTags(document) {
// 	const dom = new JSDOM(html);
// 	const document = dom.window.document;

// 	let output = "";
// 	const ignoreTags = ["script", "iframe", "noscript", "label", "style"];

// 	document.querySelectorAll("body, body *").forEach((el) => {
// 		if (ignoreTags.includes(el.tagName.toLowerCase())) {
// 			return;
// 		}

// 		Array.from(el.childNodes).forEach((node) => {
// 			if (
// 				node.nodeType === dom.window.Node.TEXT_NODE &&
// 				node.textContent.trim().length > 0
// 			) {
// 				let fullText = node.textContent.trim();
// 				let precedingSibling = node.previousSibling;

// 				while (
// 					precedingSibling &&
// 					(precedingSibling.nodeType === dom.window.Node.TEXT_NODE ||
// 						(precedingSibling.nodeType === dom.window.Node.ELEMENT_NODE &&
// 							precedingSibling.textContent.trim().length > 0))
// 				) {
// 					fullText = (
// 						precedingSibling.textContent.trim() +
// 						" " +
// 						fullText
// 					).trim();
// 					precedingSibling = precedingSibling.previousSibling;
// 				}

// 				const itemTag = el.tagName.toLowerCase();
// 				const itemText = fullText;

// 				output += `\n<${itemTag}>: ${itemText}`;
// 			}
// 		});
// 	});

// 	return output;
// }

async function scrapeUrlForTextTags(url) {
	puppeteer.use(StealthPlugin());
	const browser = await puppeteer.launch({ headless: true });
	const page = await browser.newPage();
	await page.goto(url, { waitUntil: "networkidle2" });

	const title = await page.title();

	const data = await page.evaluate(() => {
		// function extractTextWithTags() {
		// 	let output = "";
		// 	const ignoreTags = ["script", "iframe", "noscript", "label", "style"];

		// 	document.querySelectorAll("body, body *").forEach((el) => {
		// 		// Skip certain tags
		// 		if (ignoreTags.includes(el.tagName.toLowerCase())) {
		// 			return;
		// 		}

		// 		let isInsideTextGroup = false;
		// 		Array.from(el.childNodes).forEach((node) => {
		// 			// Process only text nodes that contain non-whitespace characters
		// 			if (
		// 				node.nodeType === Node.TEXT_NODE &&
		// 				node.textContent.trim().length > 0
		// 			) {
		// 				if (!isInsideTextGroup) {
		// 					let fullText = node.textContent.trim();
		// 					let precedingSibling = node.previousSibling;

		// 					// Collect text from preceding sibling elements
		// 					while (
		// 						precedingSibling &&
		// 						(precedingSibling.nodeType === Node.TEXT_NODE ||
		// 							(precedingSibling.nodeType === Node.ELEMENT_NODE &&
		// 								precedingSibling.textContent.trim().length > 0))
		// 					) {
		// 						fullText = (
		// 							precedingSibling.textContent.trim() +
		// 							" " +
		// 							fullText
		// 						).trim();
		// 						precedingSibling = precedingSibling.previousSibling;
		// 					}

		// 					const itemTag = el.tagName.toLowerCase();
		// 					const itemText = fullText;

		// 					output += `\n<${itemTag}>: ${itemText}`;

		// 					isInsideTextGroup = true;
		// 				}
		// 			} else if (node.nodeType !== Node.TEXT_NODE) {
		// 				isInsideTextGroup = false;
		// 			}
		// 		});
		// 	});

		// 	return output;
		// }
		function extractTextWithTags() {
			let output = "";
			const ignoreTags = ["script", "iframe", "noscript", "label", "style"];

			function extractText(node, parentTag) {
				if (
					node.nodeType === Node.TEXT_NODE &&
					node.textContent.trim().length > 0
				) {
					const itemTag = parentTag;
					const itemText = node.textContent.trim();

					output += `\n<${itemTag}>: ${itemText}`;
				} else if (
					node.nodeType === Node.ELEMENT_NODE &&
					!ignoreTags.includes(node.tagName.toLowerCase())
				) {
					Array.from(node.childNodes).forEach((childNode) => {
						extractText(childNode, node.tagName.toLowerCase());
					});
				}
			}

			extractText(document.body, "body");

			return output;
		}

		return extractTextWithTags();
	});

	await browser.close();
	return { title, data };
}

async function bulkScrapeUrlsForTextTags(allUrls) {
	const output = {};
	for (const url of allUrls) {
		const extractedDataStr = await scrapeUrlForTextTags(url);

		logger.info(`Data from ${url}: ${extractedDataStr}`);
		output[url] = extractedDataStr;
	}
	return output;
}

export { scrapeUrlForTextTags, bulkScrapeUrlsForTextTags };
