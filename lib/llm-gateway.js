import { validatePayload } from "#lib/validation.js";
import logger from "#lib/logger.js";
import { LLM_PREFERENCES } from "#lib/constants.js";
import { parseOrRecoverJsonString } from "#lib/utils.js";
import { generateJson as geminiGenerateJson } from "#lib/llm-gemini-rest.js";
import { generateJson as openaiGenerateJson } from "#lib/llm-openai.js";
import { generateJson as openrouterGenerateJson } from "#lib/llm-openrouter.js";
import { generateJson as nimGenerateJson } from "#lib/llm-nim.js";

// Centralizes text-only JSON generation so other modules do not need direct SDK knowledge.
// Multimodal flows (e.g., image-selection) still call provider clients directly because we
// currently only model text prompts here; extend this gateway if a shared interface is needed.
const PROVIDER_HANDLERS = {
        gemini: async (promptStr, options) => {
                const { systemMessage, systemInstruction, ...restOptions } = options;

                return geminiGenerateJson(promptStr, {
                        ...restOptions,
                        systemInstruction: systemInstruction ?? systemMessage ?? "",
                });
        },
        openai: async (promptStr, options) => openaiGenerateJson(promptStr, options),
        openrouter: async (promptStr, options) =>
                openrouterGenerateJson(promptStr, options),
        nim: async (promptStr, options) => nimGenerateJson(promptStr, options),
};

function getDefaultModelForProvider(provider) {
        return LLM_PREFERENCES.ORDERED.find(
                (preference) => preference?.PROVIDER === provider
        )?.MODEL;
}

export async function generateJson(promptStr = "", options = {}) {
        const {
                provider = LLM_PREFERENCES.PRIMARY?.PROVIDER,
                model,
                ...restOptions
        } = options;

        if (!provider) {
                throw new Error("LLM provider is required");
        }

        const generator = PROVIDER_HANDLERS[provider];

        if (!generator) {
                throw new Error(`Unsupported LLM provider: ${provider}`);
        }

        const resolvedModel = model ?? getDefaultModelForProvider(provider);

        if (!resolvedModel) {
                throw new Error(`No model configured for provider ${provider}`);
        }

        return generator(promptStr, {
                ...restOptions,
                model: resolvedModel,
        });
}

export async function generateJsonWithFallback(promptStr = "", options = {}) {
        const { preferenceOrder, provider, model, ...restOptions } = options;

        const baseOrder = Array.isArray(preferenceOrder) && preferenceOrder.length > 0
                ? preferenceOrder
                : Array.isArray(LLM_PREFERENCES.ORDERED)
                        ? LLM_PREFERENCES.ORDERED
                        : [];

        const orderedPreferences = [...baseOrder];

        if (provider) {
                const explicitPreference = {
                        PROVIDER: provider,
                        MODEL: model,
                };

                orderedPreferences.unshift(explicitPreference);
        }

        if (orderedPreferences.length === 0) {
                throw new Error("No LLM preferences available for fallback generation");
        }

        let lastError;

        const seenPreferences = new Set();

        for (const preference of orderedPreferences) {
                if (!preference?.PROVIDER) {
                        if (!preference?.PROVIDER) {
                                logger.warn("Skipping invalid LLM preference", { preference });
                        }
                        continue;
                }

                const { PROVIDER: selectedProvider, MODEL: selectedModel } = preference;
                const preferenceKey = `${selectedProvider}::${selectedModel ?? ""}`;
                if (seenPreferences.has(preferenceKey)) {
                        continue;
                }
                seenPreferences.add(preferenceKey);

                try {
                        return await generateJson(promptStr, {
                                ...restOptions,
                                provider: selectedProvider,
                                model: selectedModel,
                        });
                } catch (error) {
                        lastError = error;
                        logger.warn("LLM provider failed during fallback", {
                                provider: selectedProvider,
                                model: selectedModel,
                                errorMessage: error?.message,
                        });
                }
        }

        if (lastError) {
                throw lastError;
        }

        throw new Error("No valid LLM providers succeeded for fallback generation");
}

export async function generateAndParseJson(promptStr = "", options = {}) {
	const { preferenceOrder, provider, model, ...restOptions } = options;

	const baseOrder = Array.isArray(preferenceOrder) && preferenceOrder.length > 0
		? preferenceOrder
		: Array.isArray(LLM_PREFERENCES.ORDERED)
		? LLM_PREFERENCES.ORDERED
		: [];

	const orderedPreferences = [...baseOrder];

	if (provider) {
		orderedPreferences.unshift({
			PROVIDER: provider,
			MODEL: model,
		});
	}

	const seenPreferences = new Set();
	const preferencesQueue = [];

	for (const preference of orderedPreferences) {
		if (!preference?.PROVIDER) {
			logger.warn("generateAndParseJson: Skipping invalid LLM preference", {
				preference,
			});
			continue;
		}

		const key = `${preference.PROVIDER}::${preference.MODEL ?? ""}`;
		if (seenPreferences.has(key)) {
			continue;
		}

		seenPreferences.add(key);
		preferencesQueue.push({
			provider: preference.PROVIDER,
			model: preference.MODEL,
		});
	}

	if (preferencesQueue.length === 0) {
		throw new Error(
			"generateAndParseJson: No LLM preferences available for JSON generation"
		);
	}

	let lastError = null;

	for (const { provider: selectedProvider, model: selectedModel } of preferencesQueue) {
		logger.info("generateAndParseJson: Generating JSON", {
			provider: selectedProvider,
			model: selectedModel,
		});

		let rawJson;
		try {
			rawJson = await generateJson(promptStr, {
				...restOptions,
				provider: selectedProvider,
				model: selectedModel,
			});
		} catch (error) {
			lastError = error;
			logger.warn("generateAndParseJson: LLM generation failed", {
				provider: selectedProvider,
				model: selectedModel,
				errorMessage: error?.message,
			});
			continue;
		}

		try {
			const parsedJson = parseOrRecoverJsonString(rawJson, {
				allowRecovery: false,
				unwrapSingleKeyArrays: !Boolean(restOptions?.responseSchema),
			});
			validatePayload(parsedJson, restOptions.responseSchema);
			if (restOptions.validateResult) restOptions.validateResult(parsedJson);
			return { rawJson, parsedJson };
		} catch (error) {
			lastError = error;
			logger.warn("generateAndParseJson: Received invalid JSON from LLM", {
				provider: selectedProvider,
				model: selectedModel,
				errorMessage: error?.message,
			});
		}
	}

	if (lastError) {
		throw lastError;
	}

	throw new Error("generateAndParseJson: Unable to generate valid JSON response");
}

