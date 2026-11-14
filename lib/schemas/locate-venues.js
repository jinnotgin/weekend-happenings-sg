import { LOCATION_SCHEMA } from "./primitives.js";

// LOCATE_VENUES returns one full LOCATION_SCHEMA object per venue of a single event,
// in the same order as the venue names given in the prompt.
export const LOCATED_VENUES_RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		locations: {
			type: "array",
			items: LOCATION_SCHEMA,
		},
	},
	required: ["locations"],
	additionalProperties: false,
};
