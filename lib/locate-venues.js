import logger from "#lib/logger.js";
import {
	LLM_TASK_PREFERENCES,
	PROMPT_TEMPLATES,
	LOCATE_VENUES_CALL_DELAY_MS,
} from "#lib/constants.js";
import { generateAndParseJson } from "#lib/llm-gateway.js";
import { LOCATED_VENUES_RESPONSE_SCHEMA, REGION_ENUM } from "#lib/schemas/index.js";
import { sleep } from "#lib/utils.js";

// LOCATE_VENUES stage: one LLM call per event (title + brief description + venue names),
// no venue cache. Knowledge-heavy, low-judgment -> cheap Google models first (see
// LLM_TASK_PREFERENCES.LOCATE_VENUES). Calls are paced LOCATE_VENUES_CALL_DELAY_MS apart
// to stay under the 15 RPM free tier. Failures never drop the event: location fields
// stay null. Output shape per location matches the pre-2026-11-14 consolidation output
// (name, approximate_region, approximate_gps, approximate_nearest_mrt, google_maps_url),
// which the frontend reads directly.

const MAX_DESCRIPTION_CHARS = 300;

export function buildEmptyLocation(name = null) {
	return {
		name: typeof name === "string" ? name : null,
		approximate_region: null,
		approximate_gps: null,
		approximate_nearest_mrt: null,
		google_maps_url: null,
	};
}

function normalizeGps(gps) {
	if (!gps || typeof gps !== "object") return null;
	const lat = Number.isFinite(gps.lat) ? gps.lat : null;
	const lng = Number.isFinite(gps.lng) ? gps.lng : null;
	if (lat === null && lng === null) return null;
	return { lat, lng };
}

function normalizeString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeLocatedVenue(originalName, located) {
	if (!located || typeof located !== "object") {
		return buildEmptyLocation(originalName);
	}
	const region = REGION_ENUM.includes(located.approximate_region)
		? located.approximate_region
		: null;
	return {
		name: originalName,
		approximate_region: region,
		approximate_gps: normalizeGps(located.approximate_gps),
		approximate_nearest_mrt: normalizeString(located.approximate_nearest_mrt),
		google_maps_url: normalizeString(located.google_maps_url),
	};
}

function buildPrompt(event, venueNames) {
	const description =
		typeof event?.description === "string"
			? event.description.slice(0, MAX_DESCRIPTION_CHARS)
			: null;
	return JSON.stringify({
		title: event?.title ?? null,
		description,
		venues: venueNames,
	});
}

// Returns the event's locations with full location fields. Never throws.
export async function locateEventVenues(event, options = {}) {
	const { preferenceOrder = LLM_TASK_PREFERENCES.LOCATE_VENUES.ORDERED } = options;
	const originalLocations = Array.isArray(event?.locations)
		? event.locations.filter(Boolean)
		: [];
	const venueNames = originalLocations.map((location) =>
		typeof location?.name === "string" ? location.name : null
	);

	if (venueNames.filter(Boolean).length === 0) {
		return { locations: venueNames.map((name) => buildEmptyLocation(name)), called: false };
	}

	try {
		const { parsedJson } = await generateAndParseJson(buildPrompt(event, venueNames), {
			systemMessage: PROMPT_TEMPLATES.LOCATE_VENUES_SYSTEM_MESSAGE,
			responseSchema: {
				name: "LocatedVenues",
				schema: LOCATED_VENUES_RESPONSE_SCHEMA,
			},
			preferenceOrder,
		});
		const located = Array.isArray(parsedJson?.locations) ? parsedJson.locations : [];
		const byName = new Map(
			located
				.filter((item) => typeof item?.name === "string")
				.map((item) => [item.name.trim().toLowerCase(), item])
		);

		const locations = venueNames.map((name, index) => {
			if (name === null) return buildEmptyLocation(null);
			const match = byName.get(name.trim().toLowerCase()) ?? located[index];
			return normalizeLocatedVenue(name, match);
		});
		return { locations, called: true };
	} catch (error) {
		logger.warn("LOCATE_VENUES: Unable to locate venues; keeping null location fields", {
			title: event?.title,
			errorMessage: error?.message,
		});
		return { locations: venueNames.map((name) => buildEmptyLocation(name)), called: true };
	}
}

// Sequentially enriches every event's locations in place, pacing LLM calls.
export async function locateVenuesForEvents(events = []) {
	let callsMade = 0;
	for (const event of events) {
		if (callsMade > 0) {
			await sleep(LOCATE_VENUES_CALL_DELAY_MS);
		}
		const { locations, called } = await locateEventVenues(event);
		event.locations = locations;
		if (called) callsMade += 1;
	}
	return callsMade;
}
