import fs from "fs";
import path from "path";
import logger from "#lib/logger.js";

function ensureDirectoryExists(directory) {
	if (!fs.existsSync(directory)) {
		fs.mkdirSync(directory, { recursive: true });
	}
}

function ensureFilePathDirectoryExists(filePath) {
	const directory = path.dirname(filePath);
	ensureDirectoryExists(directory);
}

function saveAsText(textData, filename) {
	ensureFilePathDirectoryExists(filename);
	fs.writeFileSync(filename, textData, { encoding: "utf-8" });
	logger.info(`Wrote data to ${filename}`);
}

function appendAsText(textData, filename) {
	ensureFilePathDirectoryExists(filename);
	try {
		fs.appendFileSync(filename, textData, { encoding: "utf-8" });
		logger.info(`Appended data to ${filename}`);
	} catch (err) {
		logger.error(`Error appending data to ${filename}: ${err}`);
	}
}

function sanitizeFilename(filename) {
	// Remove invalid filename characters (e.g., <, >, :, ", /, \, |, ?, *, and control characters)
	let sanitized = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, " ");

	// Replace periods or spaces at the beginning of the filename with a single space
	// The regex '^(?:\.*|\s*)' matches any number of periods or spaces at the start of the string
	sanitized = sanitized.replace(/^(?:\.*|\s*)/, " ");

	// Remove periods or spaces at the end of the filename
	// The regex '(?:\.*|\s*)$' matches any number of periods or spaces at the end of the string
	sanitized = sanitized.replace(/(?:\.*|\s*)$/, " ");

	// Remove repeated spacing (reduces sequences of spaces or \xa0 to a single space)
	sanitized = removeRepeatedSpaces(sanitized);

	// Trim leading and trailing whitespace
	return sanitized.trim();
}

function truncateFullFilename(fullFilename) {
	const MAX_FILENAME_LENGTH = 255;

	if (fullFilename.length <= MAX_FILENAME_LENGTH) {
		return fullFilename;
	}

	const extension = fullFilename.split(".").pop(); // Get the file extension
	const truncatedLength = MAX_FILENAME_LENGTH - (extension.length + 1); // Account for the dot in the extension

	const truncatedBaseName = fullFilename.substring(0, truncatedLength);
	return `${truncatedBaseName}.${extension}`;
}

function getFilePath(folderName, fileTitle, type = null) {
	let filename = type ? `${fileTitle}_${type}` : `${fileTitle}`;
	filename = sanitizeFilename(filename);

	let fullFilename = `${filename}.txt`;
	fullFilename = truncateFullFilename(fullFilename);

	const currentWorkingDirectory = process.cwd();
	return path.join(currentWorkingDirectory, "data", folderName, fullFilename);
}

function getDirectoryPath(folderName) {
	const currentWorkingDirectory = process.cwd();
	const directoryPath = path.join(currentWorkingDirectory, "data", folderName);

	return directoryPath;
}

export {
	saveAsText,
	appendAsText,
	sanitizeFilename,
	getFilePath,
	getDirectoryPath,
};
