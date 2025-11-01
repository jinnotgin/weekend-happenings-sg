import { JSDOM } from "jsdom";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import logger from "#lib/logger.js";
import { sleep } from "#lib/utils.js";

puppeteer.use(StealthPlugin());

const DETACHED_FRAME_MESSAGE =
	/(navigating frame was detached|execution context was destroyed|Cannot find context with specified id)/i;
const TARGET_CLOSED_MESSAGE =
	/(Target closed|Session closed|Most likely the page has been closed|Execution context was destroyed)/i;
const MAIN_FRAME_EARLY_MESSAGE = /Requesting main frame too early/i;
const CREATE_TARGET_TIMEOUT_MESSAGE = /Target\.createTarget timed out/i;
const GENERIC_TIMEOUT_MESSAGE = /Navigation timeout of \d+ ms exceeded/i;
const CONNECTION_RESET_MESSAGE = /(socket hang up|ECONNRESET)/i;

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36";

function isRecoverableError(message = "") {
	return (
		DETACHED_FRAME_MESSAGE.test(message) ||
		TARGET_CLOSED_MESSAGE.test(message) ||
		MAIN_FRAME_EARLY_MESSAGE.test(message) ||
		CREATE_TARGET_TIMEOUT_MESSAGE.test(message) ||
		GENERIC_TIMEOUT_MESSAGE.test(message) ||
		CONNECTION_RESET_MESSAGE.test(message)
	);
}

async function gotoWithDomContentLoaded(page, url) {
	await retryWhenFrameDetaches(
		() =>
			page.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: 60000,
			}),
		`navigating to ${url}`
	);
}

async function waitForPageReady(page, url, { maxReloads = 1 } = {}) {
	let reloadAttempt = 0;

	while (reloadAttempt <= maxReloads) {
		try {
			await retryWhenFrameDetaches(
				() =>
					page.waitForFunction(
						() => {
							const state = document.readyState;
							return state === "complete" || state === "interactive";
						},
						{ timeout: 60000 }
					),
				"waiting for document ready state"
			);

			await retryWhenFrameDetaches(
				() => page.waitForSelector("body", { timeout: 20000 }),
				"waiting for body selector"
			);

			return;
		} catch (error) {
			const message = error?.message ?? "";

			if (reloadAttempt >= maxReloads || !isRecoverableError(message)) {
				throw error;
			}

			reloadAttempt += 1;
			logger.warn(
				`scrapeUrlForTextTags: Reload attempt ${reloadAttempt}/${maxReloads} for ${url} after readiness failure.`,
				{ errorMessage: message }
			);

			await retryWhenFrameDetaches(
				() =>
					page.reload({
						waitUntil: "domcontentloaded",
						timeout: 45000,
					}),
				`reloading ${url}`
			);

			await sleep(300 * reloadAttempt);
		}
	}
}

async function retryWhenFrameDetaches(
	action,
	description,
	{ retries = 1, backoffMs = 300 } = {}
) {
	let attempt = 0;

	while (true) {
		try {
			return await action();
		} catch (error) {
			const message = error?.message ?? "";
			const isRecoverable = isRecoverableError(message);

			if (!isRecoverable || attempt >= retries) {
				throw error;
			}

			attempt += 1;
			logger.warn(
				`scrapeUrlForTextTags: ${description} hit a transient browser error. Retrying (${attempt}/${retries})...`,
				{ errorMessage: message }
			);

			await sleep(backoffMs * attempt);
		}
	}
}

function extractTextWithTagsFromDocument(document) {
	let output = "";
	const ignoreTags = ["script", "iframe", "noscript", "label", "style"];
	const windowNode = document?.defaultView?.Node;
	const TEXT_NODE = windowNode?.TEXT_NODE ?? 3;

	document.querySelectorAll("body, body *").forEach((el) => {
		if (ignoreTags.includes(el.tagName.toLowerCase())) {
			return;
		}

		Array.from(el.childNodes).forEach((node) => {
			if (node.nodeType === TEXT_NODE && node.textContent.trim().length > 0) {
				const itemTag = el.tagName.toLowerCase();
				const itemText = node.textContent.trim();

				output += `\n<${itemTag}>: ${itemText}`;
			}
		});
	});

	return output;
}

async function fetchHtml(url) {
	const headers = {
		"User-Agent": USER_AGENT,
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	};
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 60000);

	let response;
	try {
		response = await fetch(url, {
			headers,
			redirect: "follow",
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}`);
	}

	return await response.text();
}

async function scrapeWithFetchFallback(url) {
	try {
		const html = await fetchHtml(url);
		return extractFromHtml(html);
	} catch (error) {
		logger.warn(
			"scrapeUrlForTextTags: Direct fetch failed, attempting proxy fallback.",
			{
				url,
				errorMessage: error?.message,
			}
		);
	}

	try {
		const proxiedUrl = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
		const html = await fetchHtml(proxiedUrl);
		return extractFromHtml(html);
	} catch (error) {
		logger.warn("scrapeUrlForTextTags: Proxy fetch failed.", {
			url,
			errorMessage: error?.message,
		});
		return null;
	}
}

function extractFromHtml(html = "") {
	const dom = new JSDOM(html);
	const { document } = dom.window;

	const title = document.title || null;
	const data = extractTextWithTagsFromDocument(document);

	return { title, data };
}

async function scrapeUrlForTextTags(url) {
	const maxAttempts = 2;
	let lastError = null;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let browser;
		let page;

		try {
			browser = await puppeteer.launch({
				headless: "new",
				args: ["--no-sandbox", "--disable-setuid-sandbox"],
				protocolTimeout: 120000,
			});

			page = await browser.newPage();
			page.setDefaultNavigationTimeout(60000);
			page.setDefaultTimeout(30000);

			await gotoWithDomContentLoaded(page, url);
			await waitForPageReady(page, url, { maxReloads: 1 });

			const title = await retryWhenFrameDetaches(
				() => page.title(),
				"resolving page title"
			);

			const data = await retryWhenFrameDetaches(
				() =>
					page.evaluate(() => {
						function extractTextWithTags() {
							let output = "";
							const ignoreTags = [
								"script",
								"iframe",
								"noscript",
								"label",
								"style",
							];

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
					}),
				"extracting tagged text content"
			);

			await page.close();
			await browser.close();

			return { title, data };
		} catch (error) {
			lastError = error;
			const message = error?.message ?? "";
			const isRecoverable = isRecoverableError(message);

			await page?.close().catch(() => {});
			await browser?.close().catch(() => {});

			if (attempt < maxAttempts && isRecoverable) {
				logger.warn(
					`scrapeUrlForTextTags: Attempt ${attempt} failed for ${url}. Retrying with fresh browser...`,
					{ errorMessage: message }
				);
				await sleep(300 * attempt);
				continue;
			}

			if (isRecoverable) {
				logger.warn(
					`scrapeUrlForTextTags: Attempt ${attempt} hit a recoverable error for ${url}. Falling back to HTTP fetch.`,
					{ errorMessage: message }
				);
				break;
			}

			logger.error(`scrapeUrlForTextTags: Error: ${error.message}`, { url });
			throw error;
		}
	}

	if (lastError) {
		logger.warn(
			"scrapeUrlForTextTags: Puppeteer attempts exhausted, falling back to HTTP fetch.",
			{
				url,
				errorMessage: lastError?.message,
			}
		);
	}

	const fallbackResult = await scrapeWithFetchFallback(url);

	if (fallbackResult?.data) {
		logger.info("scrapeUrlForTextTags: Fetched content via HTTP fallback.", { url });
		return fallbackResult;
	}

	const fallbackError = new Error(
		`Failed to scrape ${url} via puppeteer and HTTP fallbacks.`
	);
	logger.error("scrapeUrlForTextTags: All scraping strategies failed.", {
		url,
		puppeteerError: lastError?.message,
	});

	throw fallbackError;
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
