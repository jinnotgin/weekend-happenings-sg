import { IMAGE_SELECTION_CONFIG } from "#lib/constants.js";

export const IMAGE_SELECTION_RESPONSE_SCHEMA = {
        type: "object",
        additionalProperties: false,
        required: ["justification", "best_image"],
        properties: {
                justification: {
                        type: "string",
                        maxLength: 250,
                },
                best_image: {
                        type: "integer",
                        minimum: 1,
                        maximum: IMAGE_SELECTION_CONFIG.MAX_IMAGE_CANDIDATES,
                },
        },
};
