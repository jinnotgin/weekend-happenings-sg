import logger from "#lib/logger.js";

export async function sleep(milliseconds) {
	return new Promise((resolve) => {
		setTimeout(() => {
			resolve();
		}, milliseconds);
	});
}

export function removeRepeatedSpaces(text) {
	return text.replace(/( |\xa0)+/g, " ");
}

export function removeExcessiveLineBreaks(text) {
	// This regular expression matches three or more line breaks (\n or \r\n)
	// The '{3,}' means 'three or more' of the preceding element
	// The 'g' flag is for global search, to replace all occurrences in the string
	const excessiveLineBreaksPattern = /(\r?\n\s*){3,}/g;

	// Replace three or more line breaks with two line breaks
	return text.replace(excessiveLineBreaksPattern, "\n\n");
}

export function removeRepeatedSpacesAndExcessiveLineBreaks(text) {
	return removeExcessiveLineBreaks(removeRepeatedSpaces(text));
}

const RETRY_DELAY_MS = 5000;

// Runs func(...args), retrying up to `retries` extra times on a throw. Intermediate
// failures are logged as warnings; the final failure is re-thrown for the caller to
// log, so it isn't reported twice.
export async function retryAsyncFunction(func, retries, ...args) {
	const totalAttempts = retries + 1;
	const label = func.name || "task";
	// The first argument is usually a URL or search term; include it if it's short.
	const target =
		typeof args[0] === "string" && args[0].length <= 200 ? args[0] : undefined;

	for (let attempt = 1; ; attempt++) {
		try {
			return await func(...args);
		} catch (error) {
			const meta = {
				task: label,
				target,
				attempt,
				totalAttempts,
				errorMessage: error?.message ?? String(error),
			};

			if (attempt >= totalAttempts) {
				logger.warn(
					`retry: ${label} failed on attempt ${attempt}/${totalAttempts}; no retries left`,
					meta
				);
				throw error instanceof Error
					? error
					: new Error(`No more retries left. Function failed: ${String(error)}`);
			}

			logger.warn(
				`retry: ${label} failed on attempt ${attempt}/${totalAttempts}; retrying in ${RETRY_DELAY_MS / 1000}s`,
				meta
			);
			await sleep(RETRY_DELAY_MS);
		}
	}
}

export function trimNewLines(str) {
	return str
		.trim()
		.replace(/^\s+|\s+$/g, "")
		.trim();
}

export function removeMarkdownSyntax(string) {
	// Trim the input before any processing
	string = trimNewLines(string);

	// Detect and remove markdown format if present (case-insensitive)
	let lines = string.split("\n");
	if (lines[0].trim().startsWith("```")) lines.shift();
	if (lines[lines.length - 1].trim().startsWith("```")) lines.pop();

	// Join the lines back and check if it's valid JSON
	string = lines.join("\n");

	return trimNewLines(string);
}

export function parseOrRecoverJsonString(jsonString, options = {}) {
	const {
		allowRecovery = true,
		unwrapSingleKeyArrays = true,
	} = options;

	if (typeof jsonString !== "string") {
		throw new Error("parseOrRecoverJsonString: Input must be a string");
	}

	// as a result of enforcing JSON Mode in OpenAI models, requesting a single array will also be wrapped in an object
	// this helper function checks for such situations
	function extractArrayOrReturnObject(obj) {
		if (!unwrapSingleKeyArrays) {
			return obj;
		}
		// Check if the input is an object and has exactly one key
		if (
			obj &&
			typeof obj === "object" &&
			!Array.isArray(obj) &&
			Object.keys(obj).length === 1
		) {
			const firstKey = Object.keys(obj)[0];
			// Check if the value of this key is an array
			if (Array.isArray(obj[firstKey])) {
				return obj[firstKey];
			}
		}
		// Return the original object if it doesn't match the criteria
		return obj;
	}

	// Trim the input before any processing
	jsonString = jsonString.trim();

	// Detect and remove markdown format if present (case-insensitive)
	jsonString = removeMarkdownSyntax(jsonString);

	// Try to parse the JSON first. If it's valid, return the parsed object
	let parseError;
	try {
		return extractArrayOrReturnObject(JSON.parse(jsonString));
	} catch (error) {
		parseError =
			error instanceof Error
				? error
				: new Error(
					`parseOrRecoverJsonString: Unable to parse JSON: ${String(error)}`
				  );

		if (!allowRecovery) {
			throw parseError;
		}

		logger.info(
			"parseOrRecoverJsonString: JSON is incomplete, attempting recovery.",
			{ jsonString }
		);
	}

	// Determine if the JSON string is an object or an array
	const isObject = jsonString.startsWith("{");
	const isArray = jsonString.startsWith("[");

	// Find the last occurrence of '},' which signifies the end of a complete object
	const lastIndex = jsonString.lastIndexOf("},");

	// Check if the last complete object is found
	if (lastIndex !== -1) {
		let validJsonString;

		if (isObject) {
			// If it's an object, add ']}'
			validJsonString = jsonString.substring(0, lastIndex + 1) + "]}";
		} else if (isArray) {
			// If it's an array, just add ']'
			validJsonString = jsonString.substring(0, lastIndex + 1) + "]";
		} else {
			// If it's neither an array nor an object, log an error
			logger.error(
				"parseOrRecoverJsonString: JSON string is neither an array nor an object"
			);
			throw new Error(
				"parseOrRecoverJsonString: Input JSON is neither an object nor an array"
			);
		}

		try {
			// Parse the valid JSON string into an object
			return extractArrayOrReturnObject(JSON.parse(validJsonString));
		} catch (e) {
			logger.error(
				"parseOrRecoverJsonString: Error parsing JSON after recovery attempt: ",
				e
			);
			throw new Error(
				"parseOrRecoverJsonString: Failed to parse JSON after attempting recovery"
			);
		}
	} else {
		logger.error("parseOrRecoverJsonString: No complete object found in JSON");
	}

	throw new Error(
		"parseOrRecoverJsonString: Unable to parse or recover a complete JSON payload"
	);
}

export function getNextNDays(dayCount = 30) {
	const today = new Date();
	const daysArray = [];

	for (let i = 0; i < dayCount; i++) {
		const nextDay = new Date(today);
		nextDay.setDate(today.getDate() + i);

		const day = nextDay.getDate();
		const month = nextDay.toLocaleString("default", { month: "short" });
		const year = nextDay.getFullYear();

		daysArray.push(`${day} ${month} ${year}`);
	}

	return daysArray;
}

export function stitchStrings(stringA, stringB) {
	let maxLength = Math.min(stringA.length, stringB.length);
	let matchLength = 0;

	// Find the longest common substring at the end of stringA and the start of stringB
	for (let length = 1; length <= maxLength; length++) {
		if (stringA.endsWith(stringB.substring(0, length))) {
			matchLength = length;
		}
	}

	if (matchLength === 0) return false;

	// Concatenate stringA and the non-overlapping part of stringB
	return stringA + stringB.substring(matchLength);
}
