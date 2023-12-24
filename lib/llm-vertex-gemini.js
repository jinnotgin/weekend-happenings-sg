import { VertexAI } from "@google-cloud/vertexai";
import logger from "#lib/logger.js";
import { sleep } from "#lib/utils.js";
import { GCP_PROJECT_ID } from "#config/secrets.js";
import { GEMINI } from "#lib/constants.js";

// Initialize Vertex with your Cloud project and location
const vertexAI = new VertexAI({
	project: GCP_PROJECT_ID,
	location: GEMINI.LOCATION,
});

// Instantiate the model
const generativeVisionModel = vertexAI.preview.getGenerativeModel({
	model: GEMINI.MODEL,
});

let lastQueryTime = 0;

export async function generateText(
	promptStr = "",
	temperature = 0.9,
	maxOutputTokens = 8192,
	topK = 0,
	topP = 1
) {
	try {
		await throttle();

		const textPart = {
			text: promptStr,
		};

		const request = {
			contents: [{ role: "user", parts: [textPart] }],
			generationConfig: {
				temperature,
				maxOutputTokens,
				topP,
				topK,
			},
		};

		const timeoutMilliseconds = 5 * 60 * 1000; // 5 minutes in milliseconds
		const UNAVAILABLE_STATUS_CODE = 14;
		const retry = {
			// The set of error codes that will be retried.
			retryCodes: [UNAVAILABLE_STATUS_CODE],
			backoffSettings: {
				// Configure retry delay settings.
				// The initial amount of time to wait before retrying the request.
				initialRetryDelayMillis: 500,
				// The maximum amount of time to wait before retrying. I.e. after this
				// value is reached, the wait time will not increase further by the
				// multiplier.
				maxRetryDelayMillis: 16000,
				// The previous wait time is multiplied by this multiplier to come up
				// with the next wait time, until the max is reached.
				retryDelayMultiplier: 1.5,

				// Configure RPC and total timeout settings.
				// Timeout for the first RPC call. Subsequent retries will be based off
				// this value.
				initialRpcTimeoutMillis: timeoutMilliseconds,
				// Controls the change of timeout for each retry.
				rpcTimeoutMultiplier: 1.0,
				// The max for the per RPC timeout.
				maxRpcTimeoutMillis: timeoutMilliseconds,
				// The timeout for all calls (first call + all retries).
				totalTimeoutMillis: timeoutMilliseconds,
			},
		};

		logger.info("Gemini - Prompt:", { promptStr });

		// Create the response stream
		const responseStream = await generativeVisionModel.generateContentStream(
			request,
			{
				timeout: timeoutMilliseconds,
				retry,
			}
		);

		// Wait for the response stream to complete
		const aggregatedResponse = await responseStream.response;

		// Select the text from the response
		const fullTextResponse =
			aggregatedResponse.candidates[0].content.parts[0].text;

		logger.info("Gemini - Response:", { fullTextResponse });

		return fullTextResponse;
	} catch (error) {
		logger.error({ source: "Gemini", error });
	}
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
