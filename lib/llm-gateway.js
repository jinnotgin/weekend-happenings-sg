import logger from "#lib/logger.js";
import { LLM_PREFERENCES } from "#lib/constants.js";
import { generateJson as geminiGenerateJson } from "#lib/llm-gemini-rest.js";
import { generateJson as openaiGenerateJson } from "#lib/llm-openai.js";

const PROVIDER_HANDLERS = {
        gemini: async (promptStr, options) => {
                const { systemMessage, systemInstruction, ...restOptions } = options;

                return geminiGenerateJson(promptStr, {
                        ...restOptions,
                        systemInstruction: systemInstruction ?? systemMessage ?? "",
                });
        },
        openai: async (promptStr, options) => openaiGenerateJson(promptStr, options),
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

        const seenProviders = new Set();

        for (const preference of orderedPreferences) {
                if (!preference?.PROVIDER || seenProviders.has(preference.PROVIDER)) {
                        if (!preference?.PROVIDER) {
                                logger.warn("Skipping invalid LLM preference", { preference });
                        }
                        continue;
                }

                seenProviders.add(preference.PROVIDER);

                const { PROVIDER: selectedProvider, MODEL: selectedModel } = preference;

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
