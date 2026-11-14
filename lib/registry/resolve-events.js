import logger from "#lib/logger.js";
import { LLM_TASK_PREFERENCES, PROMPT_TEMPLATES } from "#lib/constants.js";
import { MATCHED_EVENTS_RESPONSE_SCHEMA } from "#lib/schemas/index.js";
import { normalizeEventTitle, tokenSimilarity } from "./normalize.js";
import { addDays, EVENT_MATCH_WINDOW_DAYS } from "./store.js";

// MATCH_EVENTS stage: decide which freshly consolidated events are ones we already know, so
// they keep their ID (and can reuse last run's date range and thumbnail).
//   - Candidates: registry events seen in the last 60 days that have not ended over a week ago.
//   - Auto-match: same normalised title, shared venue and unchanged datetime with a year.
//   - Unsure pairs (similar title, or same title at different venues) go to one batched LLM call.
//   - Each stored event is claimed by at most one new event per run.
// Failures only cost reuse: an unmatched event simply gets a new ID.

const ENDED_GRACE_DAYS = 7;
const ASK_SCORE_SHARED_VENUE = 0.45;
const ASK_SCORE_NO_SHARED_VENUE = 0.6;
const MAX_CANDIDATES = 3;
const MAX_EVENTS_PER_CALL = 40;
const MAX_DESCRIPTION_CHARS = 200;

async function defaultLlm(prompt, options) {
	const { generateAndParseJson } = await import("#lib/llm-gateway.js");
	return generateAndParseJson(prompt, options);
}

function venueIdsOf(event) {
	return (event.locations ?? []).map((location) => location?.venue_id).filter(Boolean);
}

function venueNames(registry, venueIds) {
	return venueIds.map((id) => registry.getVenue(id)?.name).filter(Boolean);
}

export function candidatePool(registry) {
	const recentCutoff = addDays(registry.today, -EVENT_MATCH_WINDOW_DAYS);
	const endedCutoff = addDays(registry.today, -ENDED_GRACE_DAYS);
	return [...registry.events.values()].filter(
		(stored) => stored.lastSeen >= recentCutoff && (!stored.dateEnd || stored.dateEnd >= endedCutoff)
	);
}

// Returns { auto: storedId | null, ask: [{ stored, score }] } for one new event.
export function classifyCandidates(event, pool, registry) {
	const titleKey = normalizeEventTitle(event.title);
	const datetime = typeof event.datetime === "string" ? event.datetime.trim() : "";
	const venueIds = new Set(venueIdsOf(event).map((id) => registry.canonicalVenueId(id)));
	const scored = [];

	for (const stored of pool) {
		const storedVenues = new Set(stored.venueIds.map((id) => registry.canonicalVenueId(id)));
		const sharesVenue = [...venueIds].some((id) => id && storedVenues.has(id));
		// Repeated relative wording ("This weekend") can describe a different session
		// on each scrape, even when the title and venue are identical.
		const sameDatetime = /\b(19|20)\d{2}\b/.test(datetime) && datetime === stored.datetime?.trim();
		const sameTitle = titleKey.length > 0 && titleKey === stored.titleKey;
		const score = sameTitle ? 1 : tokenSimilarity(titleKey, stored.titleKey);

		let verdict = null;
		if (sameTitle && sharesVenue && sameDatetime) verdict = "auto";
		else if (sameTitle) verdict = "ask";
		else if (sharesVenue && score >= ASK_SCORE_SHARED_VENUE) verdict = "ask";
		else if (score >= ASK_SCORE_NO_SHARED_VENUE) verdict = "ask";

		if (verdict) scored.push({ stored, score, verdict, sharesVenue });
	}

	scored.sort((a, b) => b.score - a.score || Number(b.sharesVenue) - Number(a.sharesVenue));
	const auto = scored.find((item) => item.verdict === "auto");
	return {
		auto: auto?.stored.id ?? null,
		autoScore: auto?.score ?? 0,
		ask: auto ? [] : scored.slice(0, MAX_CANDIDATES),
	};
}

async function askLlm(items, registry, llm) {
	const decisions = new Map();
	for (let index = 0; index < items.length; index += MAX_EVENTS_PER_CALL) {
		const batch = items.slice(index, index + MAX_EVENTS_PER_CALL);
		const prompt = JSON.stringify({
			events: batch.map(({ key, event, candidates }) => ({
				key,
				title: event.title,
				description:
					typeof event.description === "string"
						? event.description.slice(0, MAX_DESCRIPTION_CHARS)
						: null,
				datetime: event.datetime ?? null,
				daterange: event.daterange ?? null,
				venues: venueNames(registry, venueIdsOf(event)),
				candidates: candidates.map(({ stored }) => ({
					id: stored.id,
					title: stored.title,
					description:
						typeof stored.description === "string"
							? stored.description.slice(0, MAX_DESCRIPTION_CHARS)
							: null,
					datetime: stored.datetime,
					daterange: stored.daterange,
					venues: venueNames(registry, stored.venueIds),
				})),
			})),
		});
		try {
			const { parsedJson } = await llm(prompt, {
				systemMessage: PROMPT_TEMPLATES.MATCH_EVENTS_SYSTEM_MESSAGE,
				responseSchema: { name: "MatchedEvents", schema: MATCHED_EVENTS_RESPONSE_SCHEMA },
				preferenceOrder: LLM_TASK_PREFERENCES.REGISTRY_MATCHING.ORDERED,
			});
			for (const match of Array.isArray(parsedJson?.matches) ? parsedJson.matches : []) {
				const item = batch.find(({ key }) => key === match?.key);
				if (!item) continue;
				const allowed = item.candidates.some(({ stored }) => stored.id === match.event_id);
				decisions.set(item.key, allowed ? match.event_id : null);
			}
		} catch (error) {
			logger.warn("MATCH_EVENTS: LLM matching failed; treating unsure events as new", {
				errorMessage: error?.message,
				batchSize: batch.length,
			});
		}
	}
	return decisions;
}

// Returns Map(event object -> stored event record) for events that match a known event.
// Does not write to the registry; call registry.upsertEvent once enrichment is done.
export async function matchEventsToRegistry(events, registry, { llm = defaultLlm } = {}) {
	const pool = candidatePool(registry);
	const matches = new Map();
	const claimed = new Set();
	const autoProposals = [];
	const askItems = [];

	events.forEach((event, index) => {
		const { auto, autoScore, ask } = classifyCandidates(event, pool, registry);
		if (auto) autoProposals.push({ event, storedId: auto, score: autoScore });
		else if (ask.length > 0) askItems.push({ key: `e${index + 1}`, event, candidates: ask });
	});

	// Best auto matches claim first, so two new events can't share one identity.
	autoProposals.sort((a, b) => b.score - a.score);
	for (const { event, storedId } of autoProposals) {
		if (claimed.has(storedId)) continue;
		claimed.add(storedId);
		matches.set(event, registry.events.get(storedId));
	}

	const openAsks = askItems
		.map((item) => ({
			...item,
			candidates: item.candidates.filter(({ stored }) => !claimed.has(stored.id)),
		}))
		.filter((item) => item.candidates.length > 0);

	const decisions = openAsks.length > 0 ? await askLlm(openAsks, registry, llm) : new Map();
	for (const item of openAsks) {
		const storedId = decisions.get(item.key);
		if (!storedId || claimed.has(storedId)) continue;
		claimed.add(storedId);
		matches.set(item.event, registry.events.get(storedId));
	}

	logger.info("MATCH_EVENTS: completed", {
		events: events.length,
		pool: pool.length,
		autoMatched: autoProposals.length,
		askedLlm: openAsks.length,
		matched: matches.size,
	});
	return matches;
}

// Reuse rules for expensive enrichment, given a matched stored event.
// Date range: only when the raw datetime text is unchanged AND absolute (has a year), since
// relative text ("Every Saturday") is resolved against today's date.
export function reusableDateRange(event, stored) {
	if (!stored || !Array.isArray(stored.daterange) || stored.daterange.length !== 2) return null;
	const current = typeof event.datetime === "string" ? event.datetime.trim() : "";
	const previous = typeof stored.datetime === "string" ? stored.datetime.trim() : "";
	if (!current || current !== previous) return null;
	if (!/\b(19|20)\d{2}\b/.test(current)) return null;
	return stored.daterange;
}
