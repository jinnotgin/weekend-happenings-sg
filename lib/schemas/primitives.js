import { REGION_ENUM_WITH_NULL } from "./constants.js";

export const NULLABLE_STRING = { type: ["string", "null"] };
export const NULLABLE_NUMBER = { type: ["number", "null"] };

export const APPROXIMATE_GPS_SCHEMA = {
	type: ["object", "null"],
	properties: {
		lat: NULLABLE_NUMBER,
		lng: NULLABLE_NUMBER,
	},
	required: ["lat", "lng"],
	additionalProperties: false,
};

export const LOCATION_SCHEMA = {
	type: "object",
	properties: {
		name: NULLABLE_STRING,
		approximate_region: {
			type: ["string", "null"],
			enum: REGION_ENUM_WITH_NULL,
		},
		approximate_gps: APPROXIMATE_GPS_SCHEMA,
		approximate_nearest_mrt: NULLABLE_STRING,
		google_maps_url: NULLABLE_STRING,
	},
	required: [
		"name",
		"approximate_region",
		"approximate_gps",
		"approximate_nearest_mrt",
		"google_maps_url",
	],
	additionalProperties: false,
};

// Name-only venue, used by parsing and consolidation. Region/GPS/MRT/maps fields are
// filled later by the LOCATE_VENUES stage (see locate-venues.js).
export const LOCATION_NAME_ONLY_SCHEMA = {
	type: "object",
	properties: {
		name: NULLABLE_STRING,
	},
	required: ["name"],
	additionalProperties: false,
};

export const DATE_RANGE_SCHEMA = {
	type: "array",
	minItems: 2,
	maxItems: 2,
	items: NULLABLE_STRING,
};
