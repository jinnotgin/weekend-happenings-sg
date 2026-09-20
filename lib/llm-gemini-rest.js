import { beginModelCall, finishModelCall } from "#lib/model-metrics.js";
import { Buffer } from "node:buffer";
import logger from "#lib/logger.js";
import { GEMINI } from "#lib/constants.js";
import { GEMINI_API_KEY, GEMINI_API_KEYS } from "#config/secrets.js";

const RESOURCE_EXHAUSTED_STATUS = "RESOURCE_EXHAUSTED";
const RESOURCE_EXHAUSTED_HTTP_STATUS = 429;
const RESOURCE_EXHAUSTED_BASE_ATTEMPTS = 2;
const RESOURCE_EXHAUSTED_BUFFER_MS = 1000;

const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

const geminiApiKeys = GEMINI_API_KEYS;
let activeGeminiApiKeyIndex = 0;

const RESOURCE_EXHAUSTED_MAX_ATTEMPTS =
        RESOURCE_EXHAUSTED_BASE_ATTEMPTS + Math.max(0, geminiApiKeys.length - 1);

if (!GEMINI_API_KEY) {
        logger.warn("GEMINI_API_KEY is not set. Gemini requests will fail until it is configured.");
}

export async function generateJson(promptStr = "", options = {}) {
        const primaryModel = GEMINI.MODELS.GEMINI_3_8_FLASH;

        const {
                model = primaryModel,
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
                thinkingConfig = { thinkingLevel: ["UNIQUE_EVENTS", "CONSOLIDATE_EVENTS"].includes(options.task) ? "medium" : "low" },
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

        for (let attempt = 1; attempt <= RESOURCE_EXHAUSTED_MAX_ATTEMPTS; attempt++) {
                const currentKeyIndex = getCurrentGeminiApiKeyIndex();
                attemptedKeyIndices.add(currentKeyIndex);

                const currentApiKey = getCurrentGeminiApiKey();
                if (!currentApiKey) {
                        throw new Error("Gemini API key is missing");
                }

                const metric = beginModelCall("gemini", model, options.task);
                const started = Date.now();
                const response = await fetch(apiUrl, {
                        signal: AbortSignal.timeout(20 * 60 * 1000),
                        method: "POST",
                        headers: {
                                "Content-Type": "application/json",
                                "x-goog-api-key": currentApiKey,
                        },
                        body: JSON.stringify(buildRequestBody()),
                });

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
                                const waitMs = Math.min(15000, Math.max(0, retryDelayMs)) + RESOURCE_EXHAUSTED_BUFFER_MS;
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
                finishModelCall(metric, data.usageMetadata);
                if (data.candidates?.[0]?.finishReason !== "STOP") throw new Error("Gemini response incomplete or blocked");
                const text = extractTextFromResponse(data);

                if (!text) {
                        emptyResponseRetryCount += 1;
                        const canRetryEmptyResponse =
                                emptyResponseRetryCount < RESOURCE_EXHAUSTED_BASE_ATTEMPTS &&
                                attempt < RESOURCE_EXHAUSTED_MAX_ATTEMPTS;

                        if (canRetryEmptyResponse) {
                                logger.warn("Gemini (REST): Empty response received, retrying", {
                                        model,
                                        attempt,
                                        apiKeyIndex: currentKeyIndex,
                                        totalApiKeys: geminiApiKeys.length,
                                        data,
                                        emptyResponseRetryCount,
                                        maxEmptyResponseRetries: RESOURCE_EXHAUSTED_BASE_ATTEMPTS,
                                });
                                continue;
                        }

                        logger.error("Gemini (REST): Empty response", {
                                model,
                                apiKeyIndex: currentKeyIndex,
                                data,
                                emptyResponseRetryCount,
                                maxEmptyResponseRetries: RESOURCE_EXHAUSTED_BASE_ATTEMPTS,
                        });
                        throw new Error("Gemini returned an empty response");
                }

                logger.info("Gemini (REST): JSON generated successfully", { provider: "gemini", model, task: options.task, latencyMs: Date.now() - started, usage: data.usageMetadata });

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
                                if (part?.thought) return "";
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

