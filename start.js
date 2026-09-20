import "dotenv/config";
process.env.TZ = "Asia/Singapore";
import logger from "#lib/logger.js";

const maxMinutes = Number(process.env.MAX_RUN_MINUTES ?? 150);
if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error("Invalid MAX_RUN_MINUTES");
const deadline = setTimeout(() => {
    logger.error("Pipeline runtime budget exceeded");
    process.exit(1);
}, maxMinutes * 60000);
deadline.unref();
try {
    const { main } = await import("./index.js");
    await main();
} catch (error) {
    logger.error(`error: ${error.message}`);
    process.exitCode = 1;
} finally {
    clearTimeout(deadline);
}
