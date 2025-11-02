import { EVENT_CATEGORIES, REGION_GUIDANCE } from "#lib/constants.js";

const deriveUniqueStrings = (items = []) =>
	Array.isArray(items)
		? items.filter(
				(item, index, array) => typeof item === "string" && array.indexOf(item) === index
		  )
		: [];

export const CATEGORY_ENUM = deriveUniqueStrings(EVENT_CATEGORIES);

const regions = Array.isArray(REGION_GUIDANCE)
	? REGION_GUIDANCE.map(({ region }) => region)
	: [];

export const REGION_ENUM = deriveUniqueStrings(regions);
export const REGION_ENUM_WITH_NULL = [...REGION_ENUM, null];
