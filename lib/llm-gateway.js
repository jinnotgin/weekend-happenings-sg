import logger from "#lib/logger.js";
import {
        LLM_DEFAULT_PREFERENCE_ORDER,
        GEMINI,
        OPENROUTER,
        OPENAI,
} from "#lib/constants.js";
import { parseOrRecoverJsonString } from "#lib/utils.js";
import { generateJson as geminiGenerateJson } from "#lib/llm-gemini-rest.js";
import { generateJson as openaiGenerateJson } from "#lib/llm-openai.js";
import { generateJson as openrouterGenerateJson } from "#lib/llm-openrouter.js";

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
};

const PROVIDER_DEFAULT_MODELS = {
        gemini: GEMINI.DEFAULT_MODEL,
        openrouter: OPENROUTER.DEFAULT_MODEL,
        openai: OPENAI.MODEL_GPT5_MINI,
};

function getDefaultModelForProvider(provider) {
        return (
                LLM_DEFAULT_PREFERENCE_ORDER.find(
                        (preference) => preference?.PROVIDER === provider
                )?.MODEL ?? PROVIDER_DEFAULT_MODELS[provider]
        );
}

// Translates a preference entry's OPTIONS (constants.js) into provider-agnostic call options.
// Explicit caller options win over preference OPTIONS.
function applyPreferenceOptions(options = {}, preferenceOptions) {
        if (!preferenceOptions || typeof preferenceOptions !== "object") {
                return options;
        }
        const merged = { ...options };
        if (
                merged.reasoningEffort === undefined &&
                typeof preferenceOptions.REASONING_EFFORT === "string"
        ) {
                merged.reasoningEffort = preferenceOptions.REASONING_EFFORT;
        }
        return merged;
}

function describePreference(preference) {
        return `${preference?.PROVIDER}/${preference?.MODEL ?? "default"}`;
}

function describeNext(nextPreference) {
        return nextPreference
                ? `falling back to ${describePreference(nextPreference)}`
                : "no fallbacks left";
}

export async function generateJson(promptStr = "", options = {}) {
        const {
                provider = LLM_DEFAULT_PREFERENCE_ORDER[0]?.PROVIDER,
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
                : LLM_DEFAULT_PREFERENCE_ORDER;

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
        const queue = [];

        for (const preference of orderedPreferences) {
                if (!preference?.PROVIDER) {
                        logger.warn("Skipping invalid LLM preference", { preference });
                        continue;
                }
                const preferenceKey = `${preference.PROVIDER}::${preference.MODEL ?? ""}`;
                if (seenPreferences.has(preferenceKey)) {
                        continue;
                }
                seenPreferences.add(preferenceKey);
                queue.push(preference);
        }

        const failures = [];

        for (const [index, preference] of queue.entries()) {
                const {
                        PROVIDER: selectedProvider,
                        MODEL: selectedModel,
                        OPTIONS: preferenceOptions,
                } = preference;

                try {
                        return await generateJson(promptStr, {
                                ...applyPreferenceOptions(restOptions, preferenceOptions),
                                provider: selectedProvider,
                                model: selectedModel,
                        });
                } catch (error) {
                        lastError = error;
                        failures.push(`${describePreference(preference)}: ${error?.message}`);
                        logger.warn(
                                `LLM ${describePreference(preference)} failed (${index + 1}/${queue.length}); ${describeNext(queue[index + 1])}`,
                                {
                                        provider: selectedProvider,
                                        model: selectedModel,
                                        errorMessage: error?.message,
                                }
                        );
                }
        }

        if (lastError) {
                logger.error(`LLM generation failed: all ${queue.length} model(s) failed`, { failures });
                throw lastError;
        }

        throw new Error("No valid LLM providers succeeded for fallback generation");
}

export async function generateAndParseJson(promptStr = "", options = {}) {
	const { preferenceOrder, provider, model, ...restOptions } = options;

	const baseOrder = Array.isArray(preferenceOrder) && preferenceOrder.length > 0
		? preferenceOrder
		: LLM_DEFAULT_PREFERENCE_ORDER;

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
			preferenceOptions: preference.OPTIONS,
		});
	}

	if (preferencesQueue.length === 0) {
		throw new Error(
			"generateAndParseJson: No LLM preferences available for JSON generation"
		);
	}

	let lastRawJson = null;
	let lastError = null;
	const failures = [];

	for (const [index, {
		provider: selectedProvider,
		model: selectedModel,
		preferenceOptions,
	}] of preferencesQueue.entries()) {
		const label = describePreference({ PROVIDER: selectedProvider, MODEL: selectedModel });
		const nextPreference = preferencesQueue[index + 1];
		const next = describeNext(
			nextPreference && { PROVIDER: nextPreference.provider, MODEL: nextPreference.model }
		);
		logger.info(`generateAndParseJson: Generating JSON with ${label} (${index + 1}/${preferencesQueue.length})`, {
			provider: selectedProvider,
			model: selectedModel,
		});

		let rawJson;
		try {
			rawJson = await generateJson(promptStr, {
				...applyPreferenceOptions(restOptions, preferenceOptions),
				provider: selectedProvider,
				model: selectedModel,
			});
			lastRawJson = rawJson;
		} catch (error) {
			lastError = error;
			failures.push(`${label}: ${error?.message}`);
			logger.warn(`generateAndParseJson: ${label} failed; ${next}`, {
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
			return { rawJson, parsedJson };
		} catch (error) {
			lastError = error;
			failures.push(`${label}: invalid JSON (${error?.message})`);
			logger.warn(`generateAndParseJson: ${label} returned invalid JSON; ${next}`, {
				provider: selectedProvider,
				model: selectedModel,
				errorMessage: error?.message,
				rawJsonPreview: rawJson?.slice(0, 200),
			});
		}
	}

	if (typeof lastRawJson === "string") {
		logger.warn(
			"generateAndParseJson: All models failed to return valid JSON; attempting partial recovery of the last response",
			{ failures }
		);
		try {
			const parsedJson = parseOrRecoverJsonString(lastRawJson, {
				allowRecovery: true,
				unwrapSingleKeyArrays: !Boolean(restOptions?.responseSchema),
			});
			return { rawJson: lastRawJson, parsedJson };
		} catch (error) {
			logger.error(
				"generateAndParseJson: Partial JSON recovery failed; no usable output from any model",
				{ errorMessage: error?.message, failures }
			);
			throw error;
		}
	}

	if (lastError) {
		logger.error(
			`generateAndParseJson: All ${preferencesQueue.length} model(s) failed`,
			{ failures }
		);
		throw lastError;
	}

	throw new Error("generateAndParseJson: Unable to generate valid JSON response");
}
