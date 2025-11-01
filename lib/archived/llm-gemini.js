// Archived SDK-based Gemini helper retained for reference. Prefer the REST
// client in lib/llm-gemini-rest.js.
import { GoogleGenerativeAI } from "@google/generative-ai";
import logger from "#lib/logger.js";
import { sleep } from "#lib/utils.js";

// Access your API key as an environment variable (see "Set up your API key" above)
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY);

// NOTE: This helper previously logged the API key for debugging. The log has
// been removed to avoid accidental credential exposure.

let lastQueryTime = 0;

export async function generateText(prompt) {
	await throttle();

	const generationConfig = {
		maxOutputTokens: 8192,
	};

	// For text-only input, use the gemini-pro model
	const model = genAI.getGenerativeModel({
		model: "gemini-pro",
		generationConfig,
	});

	logger.info("Gemini Prompt:", { prompt });

	logger.info("Gemini: Generating text...");
	const result = await model.generateContent(prompt);
	const response = await result.response;
	const text = response.text();

	logger.info("Gemini Response:", { text });
	return text;
}

async function throttle() {
	// NOTE / TODO
	// Gemini has a rate limit of 60 requests per minute.
	// For now, all calls here will be artifically delayed to prevent rate limit issues.
	const QUERY_PER_MINUTE = 60 * 0.8; // buffer at 80%
	const waitTimeBetweenQueries = (60 / QUERY_PER_MINUTE) * 1000; // in milliseconds

	const timeElapsedSinceLastQuery = Date.now() - lastQueryTime;

	if (timeElapsedSinceLastQuery < waitTimeBetweenQueries) {
		const delay = waitTimeBetweenQueries - timeElapsedSinceLastQuery + 1000; // adding 1000ms for buffer
		logger.info(
			`Vertex / Text Bison: To prevent rate limit, waiting for ${delay}ms before proceeding...`
		);
		await sleep(delay);
	}
}
