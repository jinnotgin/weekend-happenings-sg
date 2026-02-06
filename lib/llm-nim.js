import OpenAI from "openai";
import logger from "#lib/logger.js";
import { NIM } from "#lib/constants.js";
import {
	parseOrRecoverJsonString,
	trimNewLines,
	removeMarkdownSyntax,
	stitchStrings,
} from "#lib/utils.js";
import { NIM_API_KEY } from "#config/secrets.js";

if (!NIM_API_KEY && !process.env.NIM_API_KEY) {
	logger.warn(
		"NIM_API_KEY is not set. NVIDIA NIM requests will fail until it is configured."
	);
}

const nim = new OpenAI({
	apiKey: NIM_API_KEY ?? process.env.NIM_API_KEY,
	baseURL: "https://integrate.api.nvidia.com/v1",
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
		logger.error("NIM: Unable to generate JSON", { error });
		throw error;
	}
}

async function _generateJson(promptStr = "", options = {}) {
	const {
		model = NIM.MODELS_FAST.GEMMA_3_27B_IT,
		systemMessage = "",
		prevAssistantMessages = [],
		temperature = 1,
		top_p = 1,
		frequency_penalty = 0,
		presence_penalty = 0,
		responseSchema,
		responseFormat,
		messages,
	} = options;

	const hasCustomMessages = Array.isArray(messages) && messages.length > 0;
	const builtMessages = hasCustomMessages
		? messages
		: buildDefaultMessages(promptStr, systemMessage, prevAssistantMessages);

	logger.info(`NIM: Generating JSON using ${model}...`);
	const resolvedResponseFormat = resolveOpenAiResponseFormat({
		responseSchema,
		responseFormat,
	});

	const completion = await nim.chat.completions.create({
		model,
		response_format: resolvedResponseFormat,
		messages: builtMessages,
		temperature,
		top_p,
		frequency_penalty,
		presence_penalty,
	});

	logger.info("NIM: JSON Generation Stopped", {
		messageCount: builtMessages.length,
		messages: summarizeMessages(builtMessages),
		completion: summarizeCompletion(completion),
	});

	const finishReason = completion.choices[0].finish_reason;
	let responsesList = [
		...prevAssistantMessages,
		completion.choices[0].message.content,
	];

	if (finishReason === "length" && !hasCustomMessages) {
		logger.info("NIM: Response was incomplete, attempting to continue response...");
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
			messages,
		});
	}

	return responsesList;
}

function buildDefaultMessages(promptStr, systemMessage, prevAssistantMessages = []) {
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

	for (const messageStr of prevAssistantMessages) {
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

	return messages;
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
	logger.info("NIM: combineJsonResponses starting", {
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

	try {
		const combinedResponseStr = responsesList.reduce((acc, item) => {
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
			const stitched = stitchStrings(
				removeMarkdownSyntax(acc),
				removeMarkdownSyntax(item)
			);
			if (stitched) {
				return stitched;
			}

			logger.info(
				"combineJsonResponses: Unable to stitch responses. Last fallback: parsing each response separately."
			);
			logger.info(
				"combineJsonResponses: Attempting to recover usable JSON from the 2 responses separately"
			);
			return JSON.stringify([
				...parseOrRecoverJsonString(acc),
				...parseOrRecoverJsonString(item),
			]);
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
