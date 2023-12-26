const { join } = require("path");

/**
 * @type {import("puppeteer").PuppeteerConfiguration}
 */

if (process.env.USING_GOOGLE_CLOUD_FUNCTIONS === "true") {
	module.exports = {
		cacheDirectory: join(__dirname, ".cache", "puppeteer"),
	};
}
