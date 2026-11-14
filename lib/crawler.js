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

function normalizeContentType(contentType = "") {
	const [type = ""] = contentType.split(";");
	return type.trim().toLowerCase();
}

function looksLikeJsonPayload(text = "") {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	) {
		try {
			JSON.parse(trimmed);
			return true;
		} catch {
			return false;
		}
	}
	return false;
}

function containsHtmlLikeTags(text = "") {
	const trimmed = text.trim();
	if (!trimmed) return false;

	if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
		return true;
	}

	return /<\/?[a-z][^>]*>/i.test(trimmed);
}

function shouldTreatAsRawContent({ contentType = "", text = "" } = {}) {
	const normalizedType = normalizeContentType(contentType);
	const trimmedText = text.trim();

	if (normalizedType) {
		if (
			normalizedType.includes("json") ||
			normalizedType.includes("text/plain") ||
			normalizedType.includes("csv")
		) {
			return true;
		}

		if (normalizedType.includes("html") || normalizedType.includes("xml")) {
			return false;
		}
	}

	if (!trimmedText) {
		return false;
	}

	if (looksLikeJsonPayload(trimmedText)) {
		return true;
	}

	return !containsHtmlLikeTags(trimmedText);
}

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
	return await retryWhenFrameDetaches(
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
				`scrape: [puppeteer] Reload attempt ${reloadAttempt}/${maxReloads} for ${url} after readiness failure.`,
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
				`scrape: [puppeteer] ${description} hit a transient browser error. Retrying in-page (${attempt}/${retries})...`,
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

async function fetchContent(url) {
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

	const contentType = response.headers.get("content-type") ?? "";
	const body = await response.text();

	return { body, contentType };
}

// Fallback strategies, tried in order after Puppeteer gives up. The first one whose
// request succeeds is returned, even if it yields no text (the caller decides).
const FETCH_FALLBACK_STRATEGIES = [
	{ name: "direct-fetch", buildUrl: (url) => url },
	{
		name: "proxy-fetch",
		buildUrl: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
	},
];

async function scrapeWithFetchFallback(url) {
	for (const [index, strategy] of FETCH_FALLBACK_STRATEGIES.entries()) {
		const next = FETCH_FALLBACK_STRATEGIES[index + 1]?.name ?? null;
		const startedAt = Date.now();
		logger.info(`scrape: [${strategy.name}] Fetching ${url}`, {
			url,
			strategy: strategy.name,
		});

		try {
			const { body, contentType } = await fetchContent(strategy.buildUrl(url));
			const result = extractFromContent(body, { contentType });
			const textLength = result?.data?.length ?? 0;
			const meta = {
				url,
				strategy: strategy.name,
				title: result?.title ?? null,
				contentType,
				bodyLength: body.length,
				textLength,
				durationMs: Date.now() - startedAt,
			};

			if (textLength > 0) {
				logger.info(
					`scrape: [${strategy.name}] Got ${textLength} chars of text`,
					meta
				);
			} else {
				logger.warn(
					`scrape: [${strategy.name}] Request succeeded but extracted no text; not trying further strategies`,
					meta
				);
			}
			return result;
		} catch (error) {
			logger.warn(
				`scrape: [${strategy.name}] Failed${next ? `; trying ${next}` : "; no strategies left"}`,
				{
					url,
					strategy: strategy.name,
					errorMessage: error?.message,
					durationMs: Date.now() - startedAt,
				}
			);
		}
	}

	return null;
}

function extractFromContent(text = "", { contentType = "" } = {}) {
	if (shouldTreatAsRawContent({ contentType, text })) {
		const trimmed = text.trim();
		const rawData = trimmed.length > 0 ? trimmed : text;
		return { title: null, data: rawData };
	}

	const dom = new JSDOM(text);
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

		const startedAt = Date.now();
		logger.info(
			`scrape: [puppeteer] Attempt ${attempt}/${maxAttempts} for ${url}`,
			{ url, strategy: "puppeteer", attempt, maxAttempts }
		);

		try {
			let mainResponse;
			browser = await puppeteer.launch({
				headless: "new",
				args: ["--no-sandbox", "--disable-setuid-sandbox"],
				protocolTimeout: 120000,
			});

			page = await browser.newPage();
			page.setDefaultNavigationTimeout(60000);
			page.setDefaultTimeout(30000);

			mainResponse = await gotoWithDomContentLoaded(page, url);
			await waitForPageReady(page, url, { maxReloads: 1 });

			const title = await retryWhenFrameDetaches(
				() => page.title(),
				"resolving page title"
			);

			const { documentContentType, bodyText } = await retryWhenFrameDetaches(
				() =>
					page.evaluate(() => {
						const body = document.body;
						return {
							documentContentType: document.contentType || "",
							bodyText: body ? body.textContent || "" : "",
						};
					}),
				"evaluating document metadata"
			);

			const networkContentType =
				normalizeContentType(mainResponse?.headers()?.["content-type"] || "") ||
				documentContentType;
			const shouldUseRaw = shouldTreatAsRawContent({
				contentType: networkContentType || documentContentType,
				text: bodyText,
			});

			let data;
			if (shouldUseRaw) {
				const trimmed = bodyText.trim();
				data = trimmed.length > 0 ? trimmed : bodyText;
			} else {
				data = await retryWhenFrameDetaches(
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
			}

			await page.close();
			await browser.close();

			const textLength = data?.length ?? 0;
			const successMeta = {
				url,
				strategy: "puppeteer",
				attempt,
				maxAttempts,
				httpStatus: mainResponse?.status() ?? null,
				title,
				contentType: networkContentType || documentContentType,
				extraction: shouldUseRaw ? "raw" : "tagged",
				bodyTextLength: bodyText.length,
				textLength,
				durationMs: Date.now() - startedAt,
			};

			if (textLength > 0) {
				logger.info(
					`scrape: [puppeteer] Got ${textLength} chars of text (HTTP ${successMeta.httpStatus})`,
					successMeta
				);
			} else {
				// Puppeteer only hands off to the HTTP fallbacks when it throws, so an
				// empty page is returned as-is. Usually a bot block or a JS-rendered page
				// whose content had not loaded yet.
				logger.warn(
					`scrape: [puppeteer] Page loaded (HTTP ${successMeta.httpStatus}, title: ${JSON.stringify(title)}) but extracted no text; HTTP fallbacks not tried because Puppeteer did not throw`,
					successMeta
				);
			}

			return { title, data };
		} catch (error) {
			lastError = error;
			const message = error?.message ?? "";
			const isRecoverable = isRecoverableError(message);

			await page?.close().catch(() => {});
			await browser?.close().catch(() => {});

			const failureMeta = {
				url,
				strategy: "puppeteer",
				attempt,
				maxAttempts,
				recoverable: isRecoverable,
				errorMessage: message,
				durationMs: Date.now() - startedAt,
			};

			if (attempt < maxAttempts && isRecoverable) {
				logger.warn(
					`scrape: [puppeteer] Attempt ${attempt}/${maxAttempts} hit a transient error; retrying with a fresh browser`,
					failureMeta
				);
				await sleep(300 * attempt);
				continue;
			}

			if (isRecoverable) {
				logger.warn(
					`scrape: [puppeteer] Attempt ${attempt}/${maxAttempts} hit a transient error; out of browser attempts, falling back to ${FETCH_FALLBACK_STRATEGIES.map((s) => s.name).join(" -> ")}`,
					failureMeta
				);
				break;
			}

			logger.warn(
				`scrape: [puppeteer] Attempt ${attempt}/${maxAttempts} failed with a non-transient error; giving up on this URL without trying HTTP fallbacks`,
				failureMeta
			);
			throw error;
		}
	}

	const fallbackResult = await scrapeWithFetchFallback(url);

	if (fallbackResult?.data) {
		return fallbackResult;
	}

	logger.warn(`scrape: All strategies failed for ${url}`, {
		url,
		strategiesTried: [
			"puppeteer",
			...FETCH_FALLBACK_STRATEGIES.map((s) => s.name),
		],
		puppeteerError: lastError?.message,
	});

	throw new Error(
		`Failed to scrape ${url} via puppeteer and HTTP fallbacks.`
	);
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
