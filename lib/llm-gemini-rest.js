import logger from "#lib/logger.js";
import { LLM_PREFERENCES } from "#lib/constants.js";
import { GEMINI_API_KEY, GEMINI_API_KEYS } from "#config/secrets.js";

const RESOURCE_EXHAUSTED_STATUS = "RESOURCE_EXHAUSTED";
const RESOURCE_EXHAUSTED_HTTP_STATUS = 429;
const RESOURCE_EXHAUSTED_BASE_ATTEMPTS = 2;
const RESOURCE_EXHAUSTED_BUFFER_MS = 1000;

const geminiApiKeys = GEMINI_API_KEYS;
let activeGeminiApiKeyIndex = 0;

const RESOURCE_EXHAUSTED_MAX_ATTEMPTS =
        RESOURCE_EXHAUSTED_BASE_ATTEMPTS + Math.max(0, geminiApiKeys.length - 1);

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
                responseMimeType,
                stopSequences,
                tools,
                thinkingConfig,
                generationConfig: generationConfigOverride,
        } = options;

        if (!getCurrentGeminiApiKey()) {
                throw new Error("Gemini API key is missing");
        }

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        const contents = [
                {
                        role: "user",
                        parts: [{ text: promptStr }],
                },
        ];

        const generationConfig = {
                ...(typeof generationConfigOverride === "object" && generationConfigOverride !== null
                        ? generationConfigOverride
                        : {}),
        };

        if (typeof temperature === "number") generationConfig.temperature = temperature;
        if (typeof maxOutputTokens === "number") generationConfig.maxOutputTokens = maxOutputTokens;
        const resolvedTopP = typeof topP === "number" ? topP : typeof top_p === "number" ? top_p : undefined;
        if (typeof resolvedTopP === "number") generationConfig.topP = resolvedTopP;
        if (typeof topK === "number") generationConfig.topK = topK;
        if (typeof candidateCount === "number") generationConfig.candidateCount = candidateCount;
        if (Array.isArray(stopSequences)) generationConfig.stopSequences = stopSequences;
        if (typeof responseMimeType === "string") generationConfig.responseMimeType = responseMimeType;
        if (thinkingConfig && typeof thinkingConfig === "object") {
                generationConfig.thinkingConfig = thinkingConfig;
        }

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

        if (Array.isArray(tools) && tools.length > 0) {
                body.tools = tools;
        }

        logger.info("Gemini (REST): Generating JSON", {
                model,
                promptPreview: promptStr.slice(0, 200),
        });

        const attemptedKeyIndices = new Set();

        for (let attempt = 1; attempt <= RESOURCE_EXHAUSTED_MAX_ATTEMPTS; attempt++) {
                const currentKeyIndex = getCurrentGeminiApiKeyIndex();
                attemptedKeyIndices.add(currentKeyIndex);

                const currentApiKey = getCurrentGeminiApiKey();
                if (!currentApiKey) {
                        throw new Error("Gemini API key is missing");
                }

                const response = await fetch(`${apiUrl}?key=${currentApiKey}`, {
                        method: "POST",
                        headers: {
                                "Content-Type": "application/json",
                        },
                        body: JSON.stringify(body),
                });

                if (!response.ok) {
                        const errorPayload = await safeReadJson(response);
                        const isResourceExhausted = shouldRetryResourceExhausted(response.status, errorPayload);

                        let rotationAttempted = false;
                        let rotatedApiKey = false;

                        if (isResourceExhausted && isDailyFreeTierLimitExceeded(errorPayload)) {
                                rotationAttempted = true;
                                const previousApiKeyIndex = currentKeyIndex;

                                if (rotateGeminiApiKey(attemptedKeyIndices)) {
                                        rotatedApiKey = true;
                                        logger.warn("Gemini (REST): Daily quota exhausted, rotated Gemini API key", {
                                                model,
                                                attempt,
                                                previousApiKeyIndex,
                                                apiKeyIndex: getCurrentGeminiApiKeyIndex(),
                                                totalApiKeys: geminiApiKeys.length,
                                                errorPayload,
                                        });
                                        continue;
                                }
                        }

                        const retryDelayMs = isResourceExhausted ? extractRetryDelayMs(errorPayload) : null;

                        if (retryDelayMs != null && attempt < RESOURCE_EXHAUSTED_MAX_ATTEMPTS) {
                                const waitMs = Math.max(0, retryDelayMs) + RESOURCE_EXHAUSTED_BUFFER_MS;
                                logger.warn("Gemini (REST): Resource exhausted, waiting to retry", {
                                        model,
                                        attempt,
                                        apiKeyIndex: currentKeyIndex,
                                        retryingInMs: waitMs,
                                        retryDelayMs,
                                        totalApiKeys: geminiApiKeys.length,
                                        rotationAttempted,
                                        rotatedApiKey,
                                        errorPayload,
                                });
                                await delay(waitMs);
                                continue;
                        }

                        if (rotationAttempted && !rotatedApiKey) {
                                logger.warn("Gemini (REST): Daily quota exhausted and no alternate Gemini API key available", {
                                        model,
                                        attempt,
                                        apiKeyIndex: currentKeyIndex,
                                        totalApiKeys: geminiApiKeys.length,
                                        errorPayload,
                                });
                        }

                        logger.error("Gemini (REST): Request failed", {
                                model,
                                status: response.status,
                                statusText: response.statusText,
                                apiKeyIndex: currentKeyIndex,
                                errorPayload,
                        });
                        throw new Error(`Gemini request failed with status ${response.status}`);
                }

                const data = await response.json();
                const text = extractTextFromResponse(data);

                if (!text) {
                        if (attempt < RESOURCE_EXHAUSTED_MAX_ATTEMPTS) {
                                logger.warn("Gemini (REST): Empty response received, retrying", {
                                        model,
                                        attempt,
                                        apiKeyIndex: currentKeyIndex,
                                        totalApiKeys: geminiApiKeys.length,
                                        data,
                                });
                                continue;
                        }

                        logger.error("Gemini (REST): Empty response", {
                                model,
                                apiKeyIndex: currentKeyIndex,
                                data,
                        });
                        throw new Error("Gemini returned an empty response");
                }

                logger.info("Gemini (REST): JSON generated successfully");

                return text;
        }

        throw new Error("Gemini request failed after exhausting retries and API keys");
}

function getCurrentGeminiApiKeyIndex() {
        return activeGeminiApiKeyIndex;
}

function getCurrentGeminiApiKey() {
        return geminiApiKeys[activeGeminiApiKeyIndex] ?? null;
}

function rotateGeminiApiKey(excludedIndices = new Set()) {
        if (geminiApiKeys.length <= 1) {
                return false;
        }

        for (let offset = 1; offset < geminiApiKeys.length; offset++) {
                const candidateIndex = (activeGeminiApiKeyIndex + offset) % geminiApiKeys.length;
                if (excludedIndices.has(candidateIndex)) {
                        continue;
                }
                activeGeminiApiKeyIndex = candidateIndex;
                return true;
        }

        return false;
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

function shouldRetryResourceExhausted(status, errorPayload) {
        if (status !== RESOURCE_EXHAUSTED_HTTP_STATUS) return false;
        const statusText = errorPayload?.error?.status;
        return statusText === RESOURCE_EXHAUSTED_STATUS;
}

function isDailyFreeTierLimitExceeded(errorPayload) {
        if (!errorPayload || typeof errorPayload !== "object") return false;

        const quotaFailure = findQuotaFailureDetail(errorPayload);
        if (quotaFailure) {
                const violations = Array.isArray(quotaFailure.violations) ? quotaFailure.violations : [];
                const violationIndicatesDailyFreeTier = violations.some((violation) => {
                        const quotaId = String(violation?.quotaId ?? "").toLowerCase();
                        const quotaMetric = String(violation?.quotaMetric ?? "").toLowerCase();
                        return quotaId.includes("perday") || quotaId.includes("per_day") || quotaMetric.includes("free_tier");
                });
                if (violationIndicatesDailyFreeTier) {
                        return true;
                }
        }

        const message = typeof errorPayload?.error?.message === "string" ? errorPayload.error.message.toLowerCase() : "";
        return message.includes("free tier") && message.includes("quota");
}

function findQuotaFailureDetail(errorPayload) {
        if (!errorPayload || typeof errorPayload !== "object") return null;
        const details = Array.isArray(errorPayload?.error?.details) ? errorPayload.error.details : [];
        return (
                details.find((detail) => detail?.["@type"] === "type.googleapis.com/google.rpc.QuotaFailure") ?? null
        );
}

function extractRetryDelayMs(errorPayload) {
        const retryInfo = Array.isArray(errorPayload?.error?.details)
                ? errorPayload.error.details.find((detail) => detail?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo")
                : null;

        if (!retryInfo?.retryDelay) return null;
        const { retryDelay } = retryInfo;

        if (typeof retryDelay === "string") {
                const match = retryDelay.trim().match(/^(\d+(?:\.\d+)?)s$/i);
                if (!match) return null;
                const seconds = Number.parseFloat(match[1]);
                return Number.isNaN(seconds) ? null : Math.round(seconds * 1000);
        }

        if (typeof retryDelay === "object" && retryDelay !== null) {
                const seconds = Number.parseInt(retryDelay.seconds ?? "0", 10);
                const nanos = Number.parseInt(retryDelay.nanos ?? "0", 10);
                if (Number.isNaN(seconds) || Number.isNaN(nanos)) return null;
                return seconds * 1000 + Math.round(nanos / 1e6);
        }

        return null;
}

function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
}
