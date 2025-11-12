import { CATEGORY_ENUM } from "./constants.js";
import { LOCATION_SCHEMA, NULLABLE_STRING } from "./primitives.js";

const CONSOLIDATED_EVENT_BASE_PROPERTIES = {
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
};

export const CONSOLIDATED_EVENT_SCHEMA = {
	type: "object",
	properties: {
		...CONSOLIDATED_EVENT_BASE_PROPERTIES,
		source: {
			type: "array",
			items: {
				type: "integer",
				minimum: 0,
			},
		},
	},
	required: [
		"title",
		"description",
		"datetime",
		"category",
		"locations",
		"source",
	],
	additionalProperties: false,
};

export const CONSOLIDATED_EVENTS_RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		events: {
			type: "array",
			items: CONSOLIDATED_EVENT_SCHEMA,
		},
	},
	required: ["events"],
	additionalProperties: false,
};
