export const UNIQUE_EVENT_TITLES_RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		uniqueEvents: {
			type: "array",
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					description: { type: ["string", "null"] },
				},
				required: ["title", "description"],
				additionalProperties: false,
			},
		},
	},
	required: ["uniqueEvents"],
	additionalProperties: false,
};
