import fs from "node:fs/promises";
import path from "node:path";
import imageType from "image-type";
import logger from "#lib/logger.js";
import {
        IMAGE_SELECTION_CONFIG,
        PROMPT_TEMPLATES,
        LLM_TASK_PREFERENCES,
} from "#lib/constants.js";
import { IMAGE_SELECTION_RESPONSE_SCHEMA } from "#lib/schemas/index.js";
import { generateJson as geminiGenerateJson } from "#lib/llm-gemini-rest.js";
import { generateJson as openaiGenerateJson } from "#lib/llm-openai.js";

function guessMimeTypeFromExtension(extension = "") {
        const normalized = extension?.toLowerCase();
        if (!normalized) return "image/jpeg";

        switch (normalized) {
                case ".jpg":
                case ".jpeg":
                        return "image/jpeg";
                case ".png":
                        return "image/png";
                case ".gif":
                        return "image/gif";
                case ".webp":
                        return "image/webp";
                default:
                        return "image/jpeg";
        }
}

async function buildImageInputs(savedImages = []) {
        const inputs = [];
        const maxInlineBytes = IMAGE_SELECTION_CONFIG.MAX_INLINE_IMAGE_BYTES;
        let accumulatedBytes = 0;

        for (let index = 0; index < savedImages.length; index++) {
                const candidate = savedImages[index];
                const filename = candidate?.filename;
                if (!filename) continue;

                const fullPath = candidate?.absolutePath;
                if (!fullPath) {
                        logger.warn("Image selection: Unable to resolve candidate path", {
                                filename,
                        });
                        continue;
                }

                let fileBuffer;
                try {
                        fileBuffer = await fs.readFile(fullPath);
                } catch (error) {
                        logger.warn("Image selection: Unable to read candidate file", {
                                filename,
                                errorMessage: error?.message,
                        });
                        continue;
                }

                if (
                        typeof maxInlineBytes === "number" &&
                        maxInlineBytes > 0 &&
                        accumulatedBytes + fileBuffer.length > maxInlineBytes
                ) {
                        logger.warn("Image selection: Skipping candidate to avoid Gemini inline size limit", {
                                filename,
                                candidateSizeBytes: fileBuffer.length,
                                accumulatedBytes,
                                maxInlineBytes,
                        });
                        continue;
                }

                const detectedType = await imageType(fileBuffer);
                const mimeType =
                        detectedType?.mime ??
                        guessMimeTypeFromExtension(path.extname(filename));

                inputs.push({
                        index: index + 1,
                        filename,
                        mimeType,
                        base64Data: fileBuffer.toString("base64"),
                        sourceUrl: candidate?.sourceUrl ?? null,
                });

                accumulatedBytes += fileBuffer.length;

                if (inputs.length >= IMAGE_SELECTION_CONFIG.MAX_IMAGE_CANDIDATES) {
                        break;
                }
        }

        return inputs;
}

function buildEventContextText(title, description) {
        const safeTitle = title?.trim() || "Untitled Event";
        const safeDescription =
                description?.trim() || "No description was provided.";
        return [
                `Event title: ${safeTitle}`,
                `Event description: ${safeDescription}`,
                `Evaluate the provided candidate photos and pick the single best match.`,
        ].join("\n");
}

function buildGeminiContents(eventContext, imageInputs) {
        const parts = [{ text: eventContext }];
        parts.push({
                text: `There are ${imageInputs.length} candidate photos, each introduced by "Candidate <number>". Use the actual image content to decide which best fits the event.`,
        });

        for (const input of imageInputs) {
                parts.push({ text: `Candidate ${input.index}: ${input.filename}` });
                parts.push({
                        inline_data: {
                                mime_type: input.mimeType,
                                data: input.base64Data,
                        },
                });
        }

        return [
                {
                        role: "user",
                        parts,
                },
        ];
}

function buildOpenAiMessages(systemMessage, eventContext, imageInputs) {
        const content = [
                { type: "text", text: eventContext },
                {
                        type: "text",
                        text: `There are ${imageInputs.length} candidate photos. Each candidate is described before its image attachment.`,
                },
        ];

        for (const input of imageInputs) {
                content.push({
                        type: "text",
                        text: `Candidate ${input.index}: ${input.filename}`,
                });
                content.push({
                        type: "image_url",
                        image_url: {
                                url: `data:${input.mimeType};base64,${input.base64Data}`,
                        },
                });
        }

        return [
                {
                        role: "system",
                        content: systemMessage,
                },
                {
                        role: "user",
                        content,
                },
        ];
}

function clampBestImageIndex(bestImage, maxIndex) {
        const numericValue = Number(bestImage);
        if (!Number.isFinite(numericValue)) {
                        return 1;
        }
        const floored = Math.floor(numericValue);
        if (floored < 1) return 1;
        if (floored > maxIndex) return maxIndex;
        return floored;
}

export async function selectBestEventImage({
        eventTitle,
        eventDescription,
        savedImages = [],
}) {
        const imageInputs = await buildImageInputs(savedImages);

        if (imageInputs.length === 0) {
                logger.warn("Image selection: No valid images available to evaluate.");
                return null;
        }

        const preferenceOrder = LLM_TASK_PREFERENCES.IMAGE_SELECTION.ORDERED ?? [];

        if (preferenceOrder.length === 0) {
                logger.warn("Image selection: No LLM preferences configured.");
                return null;
        }

        const eventContext = buildEventContextText(eventTitle, eventDescription);
        const systemInstruction = PROMPT_TEMPLATES.SELECT_EVENT_IMAGE_SYSTEM_MESSAGE;
        const responseSchema = {
                name: "EventImageSelection",
                schema: IMAGE_SELECTION_RESPONSE_SCHEMA,
        };

        let lastError = null;

        for (const preference of preferenceOrder) {
                const provider = preference?.PROVIDER;
                const model = preference?.MODEL;
                if (!provider || !model) {
                        continue;
                }

                try {
                        let rawJson;
                        if (provider === "gemini") {
                                rawJson = await geminiGenerateJson("", {
                                        model,
                                        systemInstruction,
                                        contents: buildGeminiContents(eventContext, imageInputs),
                                        responseSchema,
                                        responseMimeType: "application/json",
                                });
                        } else if (provider === "openai") {
                                rawJson = await openaiGenerateJson("", {
                                        model,
                                        messages: buildOpenAiMessages(
                                                systemInstruction,
                                                eventContext,
                                                imageInputs
                                        ),
                                        responseSchema,
                                });
                        } else {
                                logger.warn("Image selection: Unsupported provider", {
                                        provider,
                                });
                                continue;
                        }

                        const parsed = JSON.parse(rawJson);
                        const bestImageIndex = clampBestImageIndex(
                                parsed?.best_image,
                                imageInputs.length
                        );
                        const justification =
                                typeof parsed?.justification === "string"
                                        ? parsed.justification
                                        : "";

                        return {
                                bestImageIndex,
                                justification,
                                provider,
                                model,
                        };
                } catch (error) {
                        lastError = error;
                        logger.warn("Image selection: Provider failed", {
                                provider,
                                model,
                                errorMessage: error?.message,
                        });
                }
        }

        if (lastError) {
                logger.error("Image selection: All providers failed", {
                        errorMessage: lastError?.message,
                });
        }

        return null;
}
