import "dotenv/config";
import { main } from "./index.js";
import logger from "#lib/logger.js";

try {
	await main();
} catch (error) {
	logger.error(`error: ${error.message}`);
}
