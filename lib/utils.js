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

export async function retryAsyncFunction(func, retries, ...args) {
	return new Promise(async (resolve, reject) => {
		try {
			const result = await func(...args);
			resolve(result);
		} catch (error) {
			if (retries > 0) {
				logger.info(`Retrying after 5 seconds... attempts left: ${retries}`);
				await sleep(5000); // Sleep for 5000 milliseconds
				resolve(retryAsyncFunction(func, retries - 1, ...args));
			} else {
				reject("No more retries left. Function failed: " + error);
			}
		}
	});
}

export function parseOrRecoverJsonString(jsonString) {
	// Trim the input before any processing
	jsonString = jsonString.trim();

	// Detect and remove markdown format if present (case-insensitive)
	let lines = jsonString.split("\n");
	if (lines[0].trim() === "```JSON" || lines[0].trim() === "```json")
		lines.shift();
	if (lines[lines.length - 1].trim() === "```") lines.pop();

	// Join the lines back and check if it's valid JSON
	jsonString = lines.join("\n");

	// Try to parse the JSON first. If it's valid, return the parsed object
	try {
		return JSON.parse(jsonString);
	} catch (e) {
		// If parsing fails, proceed to attempt recovery
		jobLogger.info("JSON is incomplete, attempting recovery.");
	}

	// Determine if the JSON string is an object or an array
	let isObject = jsonString.startsWith("{");
	let isArray = jsonString.startsWith("[");

	// Find the last occurrence of '},' which signifies the end of a complete object
	let lastIndex = jsonString.lastIndexOf("},");

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
			jobLogger.error("JSON string is neither an array nor an object");
			return null;
		}

		try {
			// Parse the valid JSON string into an object
			return JSON.parse(validJsonString);
		} catch (e) {
			jobLogger.error("Error parsing JSON after recovery attempt: ", e);
		}
	} else {
		jobLogger.error("No complete object found in JSON");
	}

	return null;
}
