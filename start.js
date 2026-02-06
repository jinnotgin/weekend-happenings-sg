import "dotenv/config";
import { main } from "./index.js";
import logger from "#lib/logger.js";

const AVAILABLE_PHASES = [
	"scrape",
	"unique",
	"consolidate",
	"enrich",
	"compile",
];

function getArgValue(argv, key) {
	const directPrefix = `${key}=`;
	const directMatch = argv.find((arg) => arg.startsWith(directPrefix));
	if (directMatch) {
		return directMatch.slice(directPrefix.length);
	}

	const keyIndex = argv.indexOf(key);
	if (keyIndex !== -1) {
		return argv[keyIndex + 1];
	}

	return null;
}

function normalizePhase(rawPhase) {
	if (!rawPhase) {
		return "scrape";
	}

	const normalized = String(rawPhase).trim().toLowerCase();
	if (normalized === "beginning") {
		return "scrape";
	}

	return normalized;
}

function printUsage() {
	logger.info(
		`Usage: node start.js [--start-phase <phase>]\nAvailable phases: ${AVAILABLE_PHASES.join(", ")}`
	);
}

try {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		printUsage();
		process.exit(0);
	}

	const startPhase = normalizePhase(getArgValue(argv, "--start-phase"));
	if (!AVAILABLE_PHASES.includes(startPhase)) {
		logger.error(
			`Invalid value for --start-phase: "${startPhase}". Valid options: ${AVAILABLE_PHASES.join(", ")}`
		);
		printUsage();
		process.exit(1);
	}

	await main({ startPhase });
} catch (error) {
	logger.error(`error: ${error.message}`);
}
