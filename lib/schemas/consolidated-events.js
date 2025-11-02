import { PARSED_EVENT_SCHEMA } from "./parsed-events.js";

export const CONSOLIDATED_EVENT_SCHEMA = {
	type: "object",
	properties: {
		...PARSED_EVENT_SCHEMA.properties,
		source: {
			type: "array",
			items: {
				type: "integer",
				minimum: 0,
			},
		},
	},
	required: [...PARSED_EVENT_SCHEMA.required, "source"],
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
