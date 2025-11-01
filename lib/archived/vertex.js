// Archived Vertex text helper retained for historical reference only. Prefer
// lib/llm-gemini-rest.js for Google-hosted generation.
import * as aiplatform from "@google-cloud/aiplatform";
import logger from "#lib/logger.js";
import { sleep } from "#lib/utils.js";
import { GCP_PROJECT_ID } from "#config/secrets.js";
import { VERTEX } from "#lib/constants.js";

logger.warn(
        "The Vertex text generation helper is deprecated. Use the Gemini REST client via lib/llm-gemini-rest.js instead."
);

// Imports the Google Cloud Prediction service client
const { PredictionServiceClient } = aiplatform.v1;

// Import the helper module for converting arbitrary protobuf.Value objects.
const { helpers } = aiplatform;

// Specifies the location of the api endpoint
const clientOptions = {
	apiEndpoint: "us-central1-aiplatform.googleapis.com",
};

let lastQueryTime = 0;

// Instantiates a client
const predictionServiceClient = new PredictionServiceClient(clientOptions);

export async function generateText(
	promptStr = "",
	temperature = 0.2,
	maxOutputTokens = 8192,
	topP = 0.95,
	topK = 40
) {
	await throttle();

	// Configure the parent resource
	const endpoint = `projects/${GCP_PROJECT_ID}/locations/${VERTEX.LOCATION}/publishers/${VERTEX.PUBLISHER}/models/${VERTEX.MODEL}`;

	const promptData = {
		prompt: promptStr,
	};
	const instanceValue = helpers.toValue(promptData);
	const instances = [instanceValue];

	const parameter = {
		temperature,
		maxOutputTokens,
		topP,
		topK,
	};
	const parameters = helpers.toValue(parameter);

	const request = {
		endpoint,
		instances,
		parameters,
	};

	// Predict request
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
	const response = await predictionServiceClient.predict(request, {
		timeout: timeoutMilliseconds,
		retry,
	});

	const output = findEarliestStringValue(response);
	logger.info({ source: "Vertex", promptStr, output });
	return output;
}

function findEarliestStringValue(data) {
	// Check if the data array is valid
	if (!Array.isArray(data)) {
		return null;
	}

	// Iterate through each element in the data array
	for (let i = 0; i < data.length; i++) {
		const prediction = data[i];

		// Check if the prediction is not null and has the expected structure
		if (
			prediction &&
			prediction.predictions &&
			Array.isArray(prediction.predictions)
		) {
			for (let j = 0; j < prediction.predictions.length; j++) {
				const fields = prediction.predictions[j].structValue.fields;

				// Check if the content field exists and has a stringValue
				if (fields && fields.content && fields.content.kind === "stringValue") {
					return fields.content.stringValue;
				}
			}
		}
	}

	// Return null if no stringValue is found
	return null;
}

async function throttle() {
	// NOTE / TODO
	// Vertex has a rate limit of 60 requests per minute.
	// For now, all calls here will be artifically delayed to prevent rate limit issues.
	const QUERY_PER_MINUTE = 60;
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
