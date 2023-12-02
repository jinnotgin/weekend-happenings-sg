import OpenAI from "openai";
import logger from "#lib/logger.js";
import { OPENAI } from "#lib/constants.js";

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY, // without config, actually already defaults to process.env["OPENAI_API_KEY"]
});

async function generateText(
	promptStr = "",
	systemMessage = "",
	temperature = 1,
	top_p = 1,
	frequency_penalty = 0,
	presence_penalty = 0
) {
	const completion = await openai.chat.completions.create({
		model: OPENAI.MODEL,
		messages: [
			{
				role: "system",
				content: systemMessage,
			},
			{
				role: "user",
				content: promptStr,
			},
		],
		temperature,
		max_tokens: OPENAI.MAX_TOKENS,
		top_p,
		frequency_penalty,
		presence_penalty,
	});
	logger.info({ source: "OpenAI", promptStr, completion });

	const response = completion.choices[0].message.content;
	return response;
}

export { generateText };
