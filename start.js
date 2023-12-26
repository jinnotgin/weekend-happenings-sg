import { main } from "./index.js";

try {
	await main();
} catch (error) {
	logger.error(`error: ${error.message}`);
}
