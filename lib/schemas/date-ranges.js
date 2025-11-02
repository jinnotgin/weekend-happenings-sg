import { DATE_RANGE_SCHEMA } from "./primitives.js";

export const DATE_RANGES_RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		dateRanges: {
			type: "array",
			items: DATE_RANGE_SCHEMA,
		},
	},
	required: ["dateRanges"],
	additionalProperties: false,
};
