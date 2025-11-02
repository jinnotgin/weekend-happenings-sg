import OpenAI from "openai";
import logger from "#lib/logger.js";
import { LLM_PREFERENCES, OPENAI } from "#lib/constants.js";
import {
	parseOrRecoverJsonString,
	trimNewLines,
	removeMarkdownSyntax,
	stitchStrings,
} from "#lib/utils.js";
import { OPENAI_API_KEY } from "#config/secrets.js";

if (!OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
	logger.warn("OPENAI_API_KEY is not set. OpenAI requests will fail until it is configured.");
}

const openai = new OpenAI({
	apiKey: OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
});

const CONTENT_PREVIEW_LENGTH = 120;

function summarizeStringContent(content, previewLength = CONTENT_PREVIEW_LENGTH) {
	if (typeof content !== "string") {
		return { type: typeof content };
	}

	return {
		length: content.length,
		preview:
			content.length > previewLength
				? `${content.slice(0, previewLength)}... [truncated ${
						content.length - previewLength
				  } chars]`
				: content,
	};
}

function summarizeMessages(messages = []) {
	return messages.map(({ role, content }) => ({
		role,
		...summarizeStringContent(content),
	}));
}

function summarizeCompletion(completion) {
	if (!completion) {
		return undefined;
	}

	return {
		id: completion.id,
		model: completion.model,
		usage: completion.usage,
		choices: Array.isArray(completion.choices)
			? completion.choices.map(({ finish_reason, message }) => ({
					finish_reason,
					...summarizeStringContent(message?.content),
			  }))
			: undefined,
	};
}

function summarizeResponses(responsesList = []) {
	return responsesList.map((response) => summarizeStringContent(response));
}

async function generateJson(promptStr, options) {
	try {
		const responsesList = await _generateJson(promptStr, options);
		return combineJsonResponses(responsesList);
	} catch (error) {
		logger.error("Unable to generate JSON", { error });
	}
}

async function _generateJson(promptStr = "", options = {}) {
	const fallbackModel =
		LLM_PREFERENCES.FALLBACK?.MODEL ?? OPENAI.MODEL_GPT5_MINI;

	const {
		model = fallbackModel,
		systemMessage = "",
		prevAssistantMessages = [],
		temperature = 1,
		top_p = 1,
		frequency_penalty = 0,
		presence_penalty = 0,
		responseSchema,
		responseFormat,
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
	const resolvedResponseFormat = resolveOpenAiResponseFormat({
		responseSchema,
		responseFormat,
	});
	const completion = await openai.chat.completions.create({
		model,
		response_format: resolvedResponseFormat,
		messages,
		temperature,
		// max_tokens: OPENAI.MAX_TOKENS,
		top_p,
		frequency_penalty,
		presence_penalty,
	});
	logger.info("OpenAI: JSON Generation Stopped", {
		messageCount: messages.length,
		messages: summarizeMessages(messages),
		completion: summarizeCompletion(completion),
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
			responseSchema,
			responseFormat,
		});
	}

	return responsesList;
}

function resolveOpenAiResponseFormat({ responseSchema, responseFormat }) {
	if (responseFormat && typeof responseFormat === "object") {
		return responseFormat;
	}

	if (responseSchema && typeof responseSchema === "object") {
		const { name, schema } = responseSchema;
		const schemaName =
			typeof name === "string" && name.trim().length > 0
				? name.trim()
				: "StructuredJson";
		const schemaDefinition =
			schema && typeof schema === "object" ? schema : responseSchema;

		return {
			type: "json_schema",
			json_schema: {
				name: schemaName,
				schema: schemaDefinition,
			},
		};
	}

	return { type: "json_object" };
}

function combineJsonResponses(responsesList) {
	logger.info("OpenAI: combineJsonResponses starting", {
		responseCount: Array.isArray(responsesList) ? responsesList.length : 0,
		responses: summarizeResponses(responsesList),
	});

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
	let dataObject = null;
	try {
		dataObject = parseOrRecoverJsonString(
			responsesList.map((item) => trimNewLines(item)).join("")
		);
	} catch (error) {
		logger.info(
			"combineJsonResponses: Unable to parse concatenated responses, attempting recovery strategies",
			{ errorMessage: error?.message }
		);
	}
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
				{
					accSummary: summarizeStringContent(acc),
					itemSummary: summarizeStringContent(item),
				}
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
			{ responses: summarizeResponses(responsesList) }
		);
		throw error;
	}
}

export { generateJson };
