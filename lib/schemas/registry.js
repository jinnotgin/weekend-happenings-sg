// Structured-output schemas for the registry matching stages (lib/registry/*).

export const RESOLVED_VENUES_RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		groups: {
			type: "array",
			items: {
				type: "object",
				properties: {
					keys: { type: "array", items: { type: "string" } },
					match_venue_id: { type: ["string", "null"] },
					canonical_name: { type: ["string", "null"] },
					is_place: { type: "boolean" },
				},
				required: ["keys", "match_venue_id", "canonical_name", "is_place"],
				additionalProperties: false,
			},
		},
	},
	required: ["groups"],
	additionalProperties: false,
};

export const MATCHED_EVENTS_RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		matches: {
			type: "array",
			items: {
				type: "object",
				properties: {
					key: { type: "string" },
					event_id: { type: ["string", "null"] },
				},
				required: ["key", "event_id"],
				additionalProperties: false,
			},
		},
	},
	required: ["matches"],
	additionalProperties: false,
};
