import { Buffer } from "node:buffer";
import logger from "#lib/logger.js";
import { GEMINI } from "#lib/constants.js";
import { GEMINI_API_KEY, GEMINI_API_KEYS } from "#config/secrets.js";

const RESOURCE_EXHAUSTED_STATUS = "RESOURCE_EXHAUSTED";
const RESOURCE_EXHAUSTED_HTTP_STATUS = 429;
const RESOURCE_EXHAUSTED_BASE_ATTEMPTS = 2;
const RESOURCE_EXHAUSTED_BUFFER_MS = 1000;

const DEFAULT_MAX_OUTPUT_TOKENS = 65536;

// 5xx responses ("This model is currently experiencing high demand") are usually
// short-lived, so retry them a couple of times with backoff before giving up.
const TRANSIENT_HTTP_STATUSES = new Set([500, 502, 503, 504]);
const TRANSIENT_MAX_RETRIES = 2;
const TRANSIENT_BASE_DELAY_MS = 3000;

// Free-tier quotas (RPM/TPM/RPD) are enforced per Google Cloud PROJECT, not per API key.
// Rotating GEMINI_API_KEYS on daily-quota errors only helps if keys belong to different projects.

// Thinking levels supported per model family (aistudio.google.com/docs/thinking, 2026-11-14).
// Gemini 4 models have no "minimal"; Flash-Lite models default to "minimal".
const THINKING_LEVELS_BY_MODEL_PREFIX = [
        { prefix: "gemini-4-hydrogen", levels: ["low", "medium", "high", "xhigh"] },
        { prefix: "gemini-4-", levels: ["low", "medium", "high"] },
        { prefix: "gemini-3", levels: ["minimal", "low", "medium", "high"] },
];
const THINKING_LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh"];

// Hydrogen defaults to "high" thinking, which is slow/token-hungry for our dedupe/merge
// prompts; use "medium" unless a preference sets REASONING_EFFORT explicitly.
const DEFAULT_THINKING_LEVEL_BY_MODEL_PREFIX = [{ prefix: "gemini-4-hydrogen", level: "medium" }];

// Maps a REASONING_EFFORT option ("none" | "minimal" | "low" | ...) to the nearest
// thinkingLevel the model supports. Thinking cannot be fully disabled on Gemini 3+/4, so
// "none" maps to the lowest supported level. Returns undefined for unknown/older models.
function resolveThinkingLevel(model, reasoningEffort) {
        const modelName = String(model ?? "");
        const requested =
                typeof reasoningEffort === "string"
                        ? reasoningEffort.toLowerCase()
                        : DEFAULT_THINKING_LEVEL_BY_MODEL_PREFIX.find(({ prefix }) =>
                                modelName.startsWith(prefix)
                        )?.level;
        if (!requested) return undefined;

        const supported = THINKING_LEVELS_BY_MODEL_PREFIX.find(({ prefix }) =>
                modelName.startsWith(prefix)
        )?.levels;
        if (!supported) return undefined;

        const normalized = requested === "none" ? "minimal" : requested === "max" ? "xhigh" : requested;
        if (supported.includes(normalized)) return normalized;

        const requestedRank = THINKING_LEVEL_ORDER.indexOf(normalized);
        if (requestedRank === -1) return undefined;
        // Clamp to the closest supported level (lowest if below range, highest if above).
        const ranked = supported.map((level) => THINKING_LEVEL_ORDER.indexOf(level));
        if (requestedRank < ranked[0]) return supported[0];
        return supported[supported.length - 1];
}

const geminiApiKeys = GEMINI_API_KEYS;
let activeGeminiApiKeyIndex = 0;

const RESOURCE_EXHAUSTED_MAX_ATTEMPTS =
        RESOURCE_EXHAUSTED_BASE_ATTEMPTS + Math.max(0, geminiApiKeys.length - 1);

if (!GEMINI_API_KEY) {
        logger.warn("GEMINI_API_KEY is not set. Gemini requests will fail until it is configured.");
}

export async function generateJson(promptStr = "", options = {}) {
        const {
                model = GEMINI.DEFAULT_MODEL,
                systemInstruction = "",
                temperature,
                topK,
                topP,
                top_p,
                maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
                candidateCount,
                responseMimeType,
                stopSequences,
                tools,
                thinkingConfig,
                reasoningEffort,
                responseSchema,
                generationConfig: generationConfigOverride,
                contents,
        } = options;

        if (!getCurrentGeminiApiKey()) {
                throw new Error("Gemini API key is missing");
        }

        const normalizedResponseSchema = convertJsonSchemaToGeminiSchema(responseSchema);
        let includeResponseSchema = Boolean(normalizedResponseSchema);

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

        const resolvedContents =
                Array.isArray(contents) && contents.length > 0
                        ? contents
                        : [
                                {
                                        role: "user",
                                        parts: [{ text: promptStr }],
                                },
                        ];

        const baseGenerationConfig = {
                ...(typeof generationConfigOverride === "object" && generationConfigOverride !== null
                        ? generationConfigOverride
                        : {}),
        };

        if (typeof temperature === "number") baseGenerationConfig.temperature = temperature;
        if (typeof maxOutputTokens === "number") baseGenerationConfig.maxOutputTokens = maxOutputTokens;
        const resolvedTopP = typeof topP === "number" ? topP : typeof top_p === "number" ? top_p : undefined;
        if (typeof resolvedTopP === "number") baseGenerationConfig.topP = resolvedTopP;
        if (typeof topK === "number") baseGenerationConfig.topK = topK;
        if (typeof candidateCount === "number") baseGenerationConfig.candidateCount = candidateCount;
        if (Array.isArray(stopSequences)) baseGenerationConfig.stopSequences = stopSequences;
        const resolvedResponseMimeType =
                typeof responseMimeType === "string" ? responseMimeType : "application/json";
        if (typeof resolvedResponseMimeType === "string") {
                baseGenerationConfig.responseMimeType = resolvedResponseMimeType;
        }
        if (thinkingConfig && typeof thinkingConfig === "object") {
                baseGenerationConfig.thinkingConfig = thinkingConfig;
        } else {
                const thinkingLevel = resolveThinkingLevel(model, reasoningEffort);
                if (thinkingLevel) {
                        baseGenerationConfig.thinkingConfig = { thinkingLevel };
                }
        }

        if (responseSchema && !normalizedResponseSchema) {
                includeResponseSchema = false;
                logger.warn("Gemini (REST): Unable to normalize response schema, continuing without schema enforcement", {
                        model,
                });
        }

        const buildRequestBody = () => {
                const requestBody = {
                        contents: resolvedContents,
                };

                const generationConfig = { ...baseGenerationConfig };

                if (includeResponseSchema && normalizedResponseSchema) {
                        generationConfig.responseSchema = normalizedResponseSchema;
                }

                if (systemInstruction) {
                        requestBody.system_instruction = {
                                role: "system",
                                parts: [{ text: systemInstruction }],
                        };
                }

                if (Array.isArray(tools) && tools.length > 0) {
                        requestBody.tools = tools;
                }

                if (Object.keys(generationConfig).length > 0) {
                        requestBody.generationConfig = generationConfig;
                }

                return requestBody;
        };

        logger.info("Gemini (REST): Generating JSON", {
                model,
                promptPreview: promptStr.slice(0, 200),
        });

        const attemptedKeyIndices = new Set();
        let emptyResponseRetryCount = 0;
        let transientRetryCount = 0;

        for (let attempt = 1; attempt <= RESOURCE_EXHAUSTED_MAX_ATTEMPTS; attempt++) {
                const currentKeyIndex = getCurrentGeminiApiKeyIndex();
                attemptedKeyIndices.add(currentKeyIndex);

                const currentApiKey = getCurrentGeminiApiKey();
                if (!currentApiKey) {
                        throw new Error("Gemini API key is missing");
                }

                let response;
                try {
                        response = await fetch(`${apiUrl}?key=${currentApiKey}`, {
                                method: "POST",
                                headers: {
                                        "Content-Type": "application/json",
                                },
                                body: JSON.stringify(buildRequestBody()),
                        });
                } catch (error) {
                        // Network-level failure (DNS, reset, ...). The fetch error message is just
                        // "fetch failed"; the useful detail is in error.cause.
                        const reason = error?.cause?.code ?? error?.cause?.message ?? error?.message;
                        if (transientRetryCount < TRANSIENT_MAX_RETRIES) {
                                transientRetryCount += 1;
                                const waitMs = TRANSIENT_BASE_DELAY_MS * transientRetryCount;
                                logger.warn(`Gemini (REST): ${model} network error (${reason}); retry ${transientRetryCount}/${TRANSIENT_MAX_RETRIES} in ${waitMs / 1000}s`, {
                                        model,
                                        reason,
                                });
                                await delay(waitMs);
                                attempt -= 1;
                                continue;
                        }
                        throw new Error(`Gemini ${model} network error: ${reason}`, { cause: error });
                }

                if (!response.ok) {
                        const errorPayload = await safeReadJson(response);
                        if (includeResponseSchema && isResponseSchemaUnsupported(errorPayload)) {
                                includeResponseSchema = false;
                                logger.warn("Gemini (REST): responseSchema not supported by model, retrying without schema", {
                                        model,
                                        attempt,
                                        apiKeyIndex: currentKeyIndex,
                                });
                                attempt -= 1;
                                continue;
                        }

                        const apiStatus = errorPayload?.error?.status ?? null;
                        const apiMessage =
                                typeof errorPayload?.error?.message === "string"
                                        ? errorPayload.error.message
                                        : typeof errorPayload === "string"
                                                ? errorPayload.slice(0, 300)
                                                : null;
                        const failureSummary = `HTTP ${response.status}${apiStatus ? ` ${apiStatus}` : ""}${apiMessage ? `: ${apiMessage}` : ""}`;

                        if (TRANSIENT_HTTP_STATUSES.has(response.status) && transientRetryCount < TRANSIENT_MAX_RETRIES) {
                                transientRetryCount += 1;
                                const waitMs = TRANSIENT_BASE_DELAY_MS * transientRetryCount;
                                logger.warn(`Gemini (REST): ${model} returned ${failureSummary}; retry ${transientRetryCount}/${TRANSIENT_MAX_RETRIES} in ${waitMs / 1000}s`, {
                                        model,
                                        status: response.status,
                                        apiStatus,
                                        apiKeyIndex: currentKeyIndex,
                                });
                                await delay(waitMs);
                                attempt -= 1;
                                continue;
                        }

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

                        // Logged as a warning: the LLM gateway may still fall back to another model,
                        // and it logs an error itself if every model fails.
                        logger.warn(`Gemini (REST): ${model} failed with ${failureSummary}`, {
                                model,
                                status: response.status,
                                statusText: response.statusText,
                                apiStatus,
                                apiKeyIndex: currentKeyIndex,
                                transientRetries: transientRetryCount,
                                errorPayload,
                        });
                        const requestError = new Error(`Gemini ${model} failed with ${failureSummary}`);
                        requestError.status = response.status;
                        throw requestError;
                }

                const data = await response.json();
                const text = extractTextFromResponse(data);

                if (!text) {
                        emptyResponseRetryCount += 1;
                        const canRetryEmptyResponse =
                                emptyResponseRetryCount < RESOURCE_EXHAUSTED_BASE_ATTEMPTS &&
                                attempt < RESOURCE_EXHAUSTED_MAX_ATTEMPTS;

                        const emptyDiagnostics = summarizeEmptyResponse(data);

                        if (canRetryEmptyResponse) {
                                logger.warn(`Gemini (REST): ${model} returned no text (${emptyDiagnostics.reason}); retrying`, {
                                        model,
                                        attempt,
                                        apiKeyIndex: currentKeyIndex,
                                        totalApiKeys: geminiApiKeys.length,
                                        ...emptyDiagnostics,
                                        emptyResponseRetryCount,
                                        maxEmptyResponseRetries: RESOURCE_EXHAUSTED_BASE_ATTEMPTS,
                                });
                                continue;
                        }

                        logger.warn(`Gemini (REST): ${model} returned no text (${emptyDiagnostics.reason}); giving up on this model`, {
                                model,
                                apiKeyIndex: currentKeyIndex,
                                ...emptyDiagnostics,
                                emptyResponseRetryCount,
                                maxEmptyResponseRetries: RESOURCE_EXHAUSTED_BASE_ATTEMPTS,
                        });
                        throw new Error(`Gemini ${model} returned an empty response (${emptyDiagnostics.reason})`);
                }

                logger.info(`Gemini (REST): ${model} generated JSON`, {
                        model,
                        outputChars: text.length,
                        finishReason: data?.candidates?.[0]?.finishReason ?? null,
                });

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
                        .map((part) => {
                                if (typeof part?.text === "string") {
                                        return part.text;
                                }
                                if (part?.inlineData?.data) {
                                        return Buffer.from(part.inlineData.data, "base64").toString("utf8");
                                }
                                if (part?.functionCall) {
                                        return JSON.stringify(part.functionCall);
                                }
                                if (part?.jsonValue && typeof part.jsonValue === "object") {
                                        return JSON.stringify(part.jsonValue);
                                }
                                return "";
                        })
                        .filter(Boolean)
                        .join("")
                        .trim();
                if (combined) {
                        return combined;
                }
        }
        return "";
}

// A response body can only be read once, so read it as text and then try to parse it.
async function safeReadJson(response) {
        let bodyText = "";
        try {
                bodyText = await response.text();
        } catch {
                return null;
        }
        try {
                return JSON.parse(bodyText);
        } catch {
                return bodyText.slice(0, 1000);
        }
}

// Why a 200 response had no usable text: safety block, token limit, etc.
function summarizeEmptyResponse(data) {
        const candidate = data?.candidates?.[0];
        const blockReason = data?.promptFeedback?.blockReason ?? null;
        const finishReason = candidate?.finishReason ?? null;
        const reason = blockReason
                ? `prompt blocked: ${blockReason}`
                : finishReason
                        ? `finishReason ${finishReason}`
                        : data?.candidates?.length
                                ? "candidate had no text parts"
                                : "no candidates";
        return {
                reason,
                blockReason,
                finishReason,
                candidateCount: data?.candidates?.length ?? 0,
                usageMetadata: data?.usageMetadata ?? null,
        };
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

function normalizeGeminiResponseSchema(responseSchema) {
        if (!responseSchema || typeof responseSchema !== "object") {
                return null;
        }

        return responseSchema;
}

function isResponseSchemaUnsupported(errorPayload) {
        const message = String(errorPayload?.error?.message ?? "");
        return message.includes('Unknown name "responseSchema"');
}

function convertJsonSchemaToGeminiSchema(schema) {
        if (!schema || typeof schema !== "object") {
                return null;
        }

        if (schema.schema && typeof schema.schema === "object") {
                return convertJsonSchemaToGeminiSchema(schema.schema);
        }

        const convert = (node) => {
                if (!node || typeof node !== "object") {
                        return null;
                }

                const result = {};

                const normalizeType = (value) => {
                        if (Array.isArray(value)) {
                                const filtered = value.filter((item) => item && item !== "null");
                                const nullable = value.some((item) => item === "null");
                                return {
                                        type: filtered[0] ? String(filtered[0]).toUpperCase() : undefined,
                                        nullable,
                                };
                        }

                        if (typeof value === "string") {
                                return { type: value.toUpperCase(), nullable: false };
                        }

                        return { type: undefined, nullable: false };
                };

                const { type, nullable } = normalizeType(node.type);
                if (type) {
                        result.type = type;
                }

                if (nullable || node.nullable === true) {
                        result.nullable = true;
                }

                if (typeof node.description === "string") {
                        result.description = node.description;
                }

                if (Array.isArray(node.enum)) {
                        result.enum = node.enum;
                }

                if (typeof node.maxItems === "number") {
                        result.maxItems = node.maxItems;
                }

                if (typeof node.minItems === "number") {
                        result.minItems = node.minItems;
                }

                if (Array.isArray(node.required) && node.required.length > 0) {
                        result.required = node.required;
                }

                if (Array.isArray(node.propertyOrdering) && node.propertyOrdering.length > 0) {
                        result.propertyOrdering = node.propertyOrdering;
                }

                if (node.properties && typeof node.properties === "object") {
                        result.properties = {};
                        for (const [key, value] of Object.entries(node.properties)) {
                                const convertedChild = convert(value);
                                if (convertedChild) {
                                        result.properties[key] = convertedChild;
                                }
                        }
                        if (!result.type) {
                                result.type = "OBJECT";
                        }
                }

                if (node.items) {
                        const itemSchema = Array.isArray(node.items) ? node.items[0] : node.items;
                        const convertedItems = convert(itemSchema);
                        if (convertedItems) {
                                result.items = convertedItems;
                                if (!result.type) {
                                        result.type = "ARRAY";
                                }
                        }
                }

                return Object.keys(result).length > 0 ? result : null;
        };

        return convert(schema);
}
