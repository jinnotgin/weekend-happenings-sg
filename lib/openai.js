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

async function generateJson(
	promptStr = "",
	systemMessage = "",
	temperature = 1,
	top_p = 1,
	frequency_penalty = 0,
	presence_penalty = 0,
	prevAssistantMessages = []
) {
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
	const completion = await openai.chat.completions.create({
		model: OPENAI.MODEL,
		messages,
		temperature,
		// max_tokens: OPENAI.MAX_TOKENS,
		top_p,
		frequency_penalty,
		presence_penalty,
	});
	logger.info({
		source: "OpenAI",
		promptStr,
		prevAssistantMessages,
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
		responsesList = await generateJson(
			promptStr,
			systemMessage,
			temperature,
			top_p,
			frequency_penalty,
			presence_penalty,
			responsesList
		);
	}

	return combineJsonResponses(responsesList);
}

function combineJsonResponses(responsesList) {
	if (responsesList.length === 1) {
		logger.info("Only 1 response found, returning that.");
		return responsesList[0];
	}

	logger.info(
		"Attempting to simply concatenate all responses strings together"
	);
	const dataObject = parseOrRecoverJsonString(
		responsesList.map((item) => trimNewLines(item)).join("")
	);
	if (dataObject) {
		return JSON.stringify(dataObject);
	}

	try {
		const combinedResponseStr = responsesList.reduce((acc, item) => {
			if (acc === "") {
				return item;
			}

			logger.info(
				"Attempting to stitch responses together by finding common overlap",
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
					"Attempting to recover usable JSON from the 2 responses seperately"
				);
				return JSON.stringify([
					...parseOrRecoverJsonString(acc),
					...parseOrRecoverJsonString(item),
				]);
			}
		}, "");

		return JSON.stringify(combinedResponseStr);
	} catch (error) {
		logger.error(`error, Unable to combine responses: ${error.message}`);
		throw error;
	}
}

export { generateJson };
