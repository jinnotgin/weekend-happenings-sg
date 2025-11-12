import { NULLABLE_STRING } from "./primitives.js";

const LOCATION_NAME_ONLY_SCHEMA = {
	type: "object",
	properties: {
		name: NULLABLE_STRING,
	},
	required: ["name"],
	additionalProperties: false,
};

export const PARSED_EVENT_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string" },
		description: { type: "string", minLength: 1 },
		datetime: NULLABLE_STRING,
		locations: {
			type: "array",
			items: LOCATION_NAME_ONLY_SCHEMA,
		},
	},
	required: ["title", "description", "datetime", "locations"],
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
