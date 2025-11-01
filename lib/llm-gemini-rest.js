import logger from "#lib/logger.js";
import { LLM_PREFERENCES } from "#lib/constants.js";
import { GEMINI_API_KEY } from "#config/secrets.js";

if (!GEMINI_API_KEY) {
        logger.warn("GEMINI_API_KEY is not set. Gemini requests will fail until it is configured.");
}

export async function generateJson(promptStr = "", options = {}) {
        const primaryModel = LLM_PREFERENCES.PRIMARY?.MODEL ?? LLM_PREFERENCES.ORDERED[0]?.MODEL;

        const {
                model = primaryModel,
                systemInstruction = "",
                temperature,
                topK,
                topP,
                top_p,
                maxOutputTokens = 8192,
                candidateCount,
        } = options;

        if (!GEMINI_API_KEY) {
                throw new Error("GEMINI_API_KEY is missing");
        }

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        const contents = [
                {
                        role: "user",
                        parts: [{ text: promptStr }],
                },
        ];

        const generationConfig = {};

        if (typeof temperature === "number") generationConfig.temperature = temperature;
        if (typeof maxOutputTokens === "number") generationConfig.maxOutputTokens = maxOutputTokens;
        const resolvedTopP = typeof topP === "number" ? topP : typeof top_p === "number" ? top_p : undefined;
        if (typeof resolvedTopP === "number") generationConfig.topP = resolvedTopP;
        if (typeof topK === "number") generationConfig.topK = topK;
        if (typeof candidateCount === "number") generationConfig.candidateCount = candidateCount;

        const body = {
                contents,
        };

        if (Object.keys(generationConfig).length > 0) {
                body.generationConfig = generationConfig;
        }

        if (systemInstruction) {
                body.system_instruction = {
                        role: "system",
                        parts: [{ text: systemInstruction }],
                };
        }

        logger.info("Gemini (REST): Generating JSON", {
                model,
                promptPreview: promptStr.slice(0, 200),
        });

        const response = await fetch(`${apiUrl}?key=${GEMINI_API_KEY}`, {
                method: "POST",
                headers: {
                        "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
        });

        if (!response.ok) {
                        const errorPayload = await safeReadJson(response);
                        logger.error("Gemini (REST): Request failed", {
                                model,
                                status: response.status,
                                statusText: response.statusText,
                                errorPayload,
                        });
                        throw new Error(`Gemini request failed with status ${response.status}`);
        }

        const data = await response.json();
        const text = extractTextFromResponse(data);

        if (!text) {
                logger.error("Gemini (REST): Empty response", { model, data });
                throw new Error("Gemini returned an empty response");
        }

        logger.info("Gemini (REST): JSON generated successfully");

        return text;
}

function extractTextFromResponse(data) {
        if (!data) return "";
        const candidates = data.candidates || [];
        for (const candidate of candidates) {
                const parts = candidate?.content?.parts;
                if (!parts) continue;
                const combined = parts
                        .map((part) => part?.text)
                        .filter(Boolean)
                        .join("")
                        .trim();
                if (combined) {
                        return combined;
                }
        }
        return "";
}

async function safeReadJson(response) {
        try {
                return await response.json();
        } catch (error) {
                logger.warn("Gemini (REST): Unable to parse error payload as JSON");
                return await response.text();
        }
}
