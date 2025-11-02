export const UNIQUE_EVENT_TITLES_RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		uniqueEvents: {
			type: "array",
			items: { type: "string" },
		},
	},
	required: ["uniqueEvents"],
	additionalProperties: false,
};
