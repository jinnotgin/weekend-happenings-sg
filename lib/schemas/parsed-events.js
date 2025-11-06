import { CATEGORY_ENUM } from "./constants.js";
import { LOCATION_SCHEMA, NULLABLE_STRING } from "./primitives.js";

export const PARSED_EVENT_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string" },
                description: { type: "string", minLength: 1 },
		datetime: NULLABLE_STRING,
		category: {
			type: "array",
			items: {
				type: "string",
				enum: CATEGORY_ENUM,
			},
			uniqueItems: true,
		},
		locations: {
			type: "array",
			items: LOCATION_SCHEMA,
		},
	},
	required: ["title", "description", "datetime", "category", "locations"],
	additionalProperties: false,
};

export const PARSED_EVENTS_RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		events: {
			type: "array",
			items: PARSED_EVENT_SCHEMA,
		},
	},
	required: ["events"],
	additionalProperties: false,
};
