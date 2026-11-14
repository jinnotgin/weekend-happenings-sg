import logger from "#lib/logger.js";
import { LLM_TASK_PREFERENCES, PROMPT_TEMPLATES } from "#lib/constants.js";
import { RESOLVED_VENUES_RESPONSE_SCHEMA } from "#lib/schemas/index.js";
import { normalizeVenueName, isVagueVenueName, tokenSimilarity } from "./normalize.js";

// RESOLVE_VENUES stage: give every event location a stable venue_id.
//   1. Placeholder names ("Various locations", "Online") -> venue_id null, no LLM.
//   2. Exact alias hit in the registry -> that venue, no LLM.
//   3. Everything else goes to ONE batched LLM call together with a short list of similar
//      registry venues; the model groups names into places and says which (if any) known
//      venue each group is. New places are created with a clean canonical name.
// If the LLM call fails, fallback reuses exact aliases and assigns new IDs to the rest.
// Similar names and addresses require an explicit model decision to share an identity.

const MAX_CANDIDATES = 5;
const MIN_CANDIDATE_SCORE = 0.35;
const MAX_NAMES_PER_CALL = 60;

async function defaultLlm(prompt, options) {
	const { generateAndParseJson } = await import("#lib/llm-gateway.js");
	return generateAndParseJson(prompt, options);
}

// Keep address and branch details when no model decision is available. A generic
// fallback name would add an alias that incorrectly binds other branches to this one.
export function fallbackCanonicalName(rawName) {
	return String(rawName ?? "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
}

function buildAliasIndex(registry) {
	// venueId -> set of normalised strings it is known by (its name + every alias).
	const index = new Map();
	for (const venue of registry.activeVenues()) {
		index.set(venue.id, new Set([normalizeVenueName(venue.name)]));
	}
	for (const [alias, venueId] of registry.aliases) {
		const canonicalId = registry.canonicalVenueId(venueId);
		if (canonicalId && index.has(canonicalId)) index.get(canonicalId).add(alias);
	}
	return index;
}

export function shortlistCandidates(normalizedName, registry, aliasIndex) {
	const scored = [];
	for (const [venueId, aliases] of aliasIndex) {
		let best = 0;
		for (const alias of aliases) {
			best = Math.max(best, tokenSimilarity(normalizedName, alias));
		}
		if (best >= MIN_CANDIDATE_SCORE) {
			scored.push({
				id: venueId, name: registry.getVenue(venueId).name, aliases: [...aliases], score: best,
			});
		}
	}
	return scored.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

function applyFallback(item, registry, assignments) {
	// A previous fallback in this same run may already have created this place.
	const existing = registry.findVenueByName(item.rawNames[0]);
	if (existing) {
		assignments.set(item.alias, existing.id);
		return;
	}
	const venue = registry.createVenue(fallbackCanonicalName(item.rawNames[0]), item.rawNames);
	assignments.set(item.alias, venue.id);
}

async function resolveBatchWithLlm(batch, registry, assignments, llm) {
	const keyed = batch.map((item, index) => ({ ...item, key: `n${index + 1}` }));
	const byKey = new Map(keyed.map((item) => [item.key, item]));
	const prompt = JSON.stringify({
		names: keyed.map((item) => ({
			key: item.key,
			name: item.rawNames[0],
			event_title: item.eventTitle,
			candidates: item.candidates.map(({ id, name, aliases }) => ({ id, name, aliases })),
		})),
	});

	const { parsedJson } = await llm(prompt, {
		systemMessage: PROMPT_TEMPLATES.RESOLVE_VENUES_SYSTEM_MESSAGE,
		responseSchema: { name: "ResolvedVenues", schema: RESOLVED_VENUES_RESPONSE_SCHEMA },
		preferenceOrder: LLM_TASK_PREFERENCES.REGISTRY_MATCHING.ORDERED,
	});
	const groups = Array.isArray(parsedJson?.groups) ? parsedJson.groups : [];
	const handled = new Set();

	for (const group of groups) {
		const items = (Array.isArray(group?.keys) ? group.keys : [])
			.filter((key) => byKey.has(key) && !handled.has(key))
			.map((key) => byKey.get(key));
		if (items.length === 0) continue;
		items.forEach((item) => handled.add(item.key));

		if (group.is_place === false) {
			items.forEach((item) => assignments.set(item.alias, null));
			continue;
		}

		const rawNames = items.flatMap((item) => item.rawNames);
		const allowedIds = new Set(items.flatMap((item) => item.candidates.map(({ id }) => id)));
		let venueId =
			typeof group.match_venue_id === "string" && allowedIds.has(group.match_venue_id)
				? registry.canonicalVenueId(group.match_venue_id)
				: null;

		if (!venueId) {
			const qualifiedName = rawNames.find((name) => /[,#\d]/.test(name));
			const canonicalName = qualifiedName
				? fallbackCanonicalName(qualifiedName)
				: typeof group.canonical_name === "string" && group.canonical_name.trim()
					? group.canonical_name.trim()
					: fallbackCanonicalName(rawNames[0]);
			// A new-place decision must not silently reuse a generic canonical-name alias.
			// Only the model's explicit candidate ID can establish that equivalence.
			venueId = registry.createVenue(canonicalName).id;
		}
		for (const rawName of rawNames) registry.addAlias(rawName, venueId);
		items.forEach((item) => assignments.set(item.alias, venueId));
	}

	const missing = keyed.filter((item) => !handled.has(item.key));
	if (missing.length > 0) {
		logger.warn("RESOLVE_VENUES: LLM left names ungrouped; using fallback for them", {
			count: missing.length,
		});
		missing.forEach((item) => applyFallback(item, registry, assignments));
	}
}

// Mutates each event's `locations` to [{ name, venue_id, venue_name }]. Location detail
// fields are added afterwards from the registry (see locateRegistryVenues).
export async function resolveVenuesForEvents(events, registry, { llm = defaultLlm } = {}) {
	const assignments = new Map(); // normalised alias -> venueId | null
	const pending = new Map(); // normalised alias -> { alias, rawNames, eventTitle }
	let exactHits = 0;
	let vague = 0;

	for (const event of events) {
		for (const location of event.locations ?? []) {
			const rawName = typeof location?.name === "string" ? location.name.trim() : "";
			const alias = normalizeVenueName(rawName);
			if (!rawName || isVagueVenueName(rawName)) {
				vague += 1;
				continue;
			}
			if (assignments.has(alias)) continue;
			const pendingItem = pending.get(alias);
			if (pendingItem) {
				if (!pendingItem.rawNames.includes(rawName)) pendingItem.rawNames.push(rawName);
				continue;
			}
			const known = registry.findVenueByName(rawName);
			if (known) {
				assignments.set(alias, known.id);
				exactHits += 1;
				continue;
			}
			pending.set(alias, { alias, rawNames: [rawName], eventTitle: event.title ?? null });
		}
	}

	const aliasIndex = buildAliasIndex(registry);
	const unresolved = [...pending.values()].map((item) => ({
		...item,
		candidates: shortlistCandidates(item.alias, registry, aliasIndex),
	}));

	let llmCalls = 0;
	for (let index = 0; index < unresolved.length; index += MAX_NAMES_PER_CALL) {
		const batch = unresolved.slice(index, index + MAX_NAMES_PER_CALL);
		try {
			llmCalls += 1;
			await resolveBatchWithLlm(batch, registry, assignments, llm);
		} catch (error) {
			logger.warn("RESOLVE_VENUES: LLM matching failed; using deterministic fallback", {
				errorMessage: error?.message,
				batchSize: batch.length,
			});
			batch.forEach((item) => applyFallback(item, registry, assignments));
		}
	}

	for (const event of events) {
		event.locations = (event.locations ?? []).filter(Boolean).map((location) => {
			const rawName = typeof location?.name === "string" ? location.name.trim() : null;
			const venueId = rawName ? assignments.get(normalizeVenueName(rawName)) ?? null : null;
			const venue = venueId ? registry.getVenue(venueId) : null;
			if (venue) registry.touchVenue(venue.id);
			return { name: rawName, venue_id: venue?.id ?? null, venue_name: venue?.name ?? null };
		});
	}

	const summary = {
		exactHits,
		vague,
		sentToLlm: unresolved.length,
		llmCalls,
		newVenues: registry.stats.newVenues,
	};
	logger.info("RESOLVE_VENUES: completed", summary);
	return summary;
}
