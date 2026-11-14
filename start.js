import "dotenv/config";
import { main } from "./index.js";
import logger from "#lib/logger.js";

try {
	await main();
} catch (error) {
	logger.error(`error: ${error.message}`);
	// Non-zero exit so schedulers (e.g. GitHub Actions) mark the run as failed.
	process.exitCode = 1;
}
