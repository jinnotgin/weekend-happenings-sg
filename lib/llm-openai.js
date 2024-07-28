import OpenAI from "openai";
import logger from "#lib/logger.js";
import { OPENAI } from "#lib/constants.js";
import {
	parseOrRecoverJsonString,
	trimNewLines,
	removeMarkdownSyntax,
	stitchStrings,
} from "#lib/utils.js";

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY, // without config, actually already defaults to process.env["OPENAI_API_KEY"]
});

async function generateJson(promptStr, options) {
	try {
		const responsesList = await _generateJson(promptStr, options);
		return combineJsonResponses(responsesList);
	} catch (error) {
		logger.error("Unable to generate JSON", { error });
	}
}

async function _generateJson(promptStr = "", options = {}) {
	const {
		model = OPENAI.MODEL_GPT4o,
		systemMessage = "",
		prevAssistantMessages = [],
		temperature = 1,
		top_p = 1,
		frequency_penalty = 0,
		presence_penalty = 0,
	} = options;

	const messages = [
		{
			role: "system",
			content: systemMessage,
		},
		{
			role: "user",
			content: promptStr,
		},
	];

	for (let messageStr of prevAssistantMessages) {
		messages.push({
			role: "assistant",
			content: messageStr,
		});
	}
	if (prevAssistantMessages.length > 0) {
		messages.push({
			role: "user",
			content:
				"please continue where you left off, in the same format as system message. if you were returning a JSON array, please repeat the last item that was cutoff.",
		});
	}

	logger.info(`OpenAI: Generating JSON using ${model}...`);
	const completion = await openai.chat.completions.create({
		model,
		response_format: { type: "json_object" },
		messages,
		temperature,
		// max_tokens: OPENAI.MAX_TOKENS,
		top_p,
		frequency_penalty,
		presence_penalty,
	});
	logger.info({
		source: "OpenAI: JSON Generation Stopped",
		messages,
		completion,
	});

	const finishReason = completion.choices[0].finish_reason;
	let responsesList = [
		...prevAssistantMessages,
		completion.choices[0].message.content,
	];

	if (finishReason === "length") {
		logger.info(
			"OpenAI: Response was incomplete, attempting to continue response..."
		);
		responsesList = await _generateJson(promptStr, {
			model,
			systemMessage,
			prevAssistantMessages: responsesList,
			temperature,
			top_p,
			frequency_penalty,
			presence_penalty,
		});
	}

	return responsesList;
}

function combineJsonResponses(responsesList) {
	logger.info("OpenAI: combineJsonResponses starting", { responsesList });

	if (!Array.isArray(responsesList)) {
		throw new Error("responsesList must be an array.");
	}

	if (responsesList.length === 0) {
		throw new Error("responsesList is empty");
	}

	if (responsesList.length === 1) {
		logger.info("combineJsonResponses: Only 1 response found, returning that.");
		return responsesList[0];
	}

	logger.info(
		"combineJsonResponses: Attempting to simply concatenate all responses strings together"
	);
	const dataObject = parseOrRecoverJsonString(
		responsesList.map((item) => trimNewLines(item)).join("")
	);
	if (dataObject) {
		return JSON.stringify(dataObject);
	}

	let combinedResponseStr = null;
	try {
		combinedResponseStr = responsesList.reduce((acc, item) => {
			if (acc === "") {
				return item;
			}

			logger.info(
				"combineJsonResponses: Attempting to stitch responses together by finding common overlap",
				{ acc, item }
			);
			let stiched = stitchStrings(
				removeMarkdownSyntax(acc),
				removeMarkdownSyntax(item)
			);
			if (stiched) {
				return stiched;
			} else {
				logger.info(
					"combineJsonResponses: Attempting to recover usable JSON from the 2 responses seperately"
				);
				return JSON.stringify([
					...parseOrRecoverJsonString(acc),
					...parseOrRecoverJsonString(item),
				]);
			}
		}, "");

		return combinedResponseStr;
	} catch (error) {
		logger.error(
			`combineJsonResponses error: Unable to combine responses: ${error.message}`,
			{ responsesList }
		);
		throw error;
	}
}

export { generateJson };
