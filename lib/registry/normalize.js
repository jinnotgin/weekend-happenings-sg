// Pure string helpers for matching venue names and event titles across runs.
// No I/O, no LLM: everything here is deterministic and unit-testable.

const STOPWORDS = new Set(["the", "at", "of", "and", "in", "sg", "singapore", "a"]);

const VAGUE_VENUE_PATTERNS = [
	/^$/,
	/^(various|multiple|several|selected|participating|island ?wide|nationwide)\b/,
	/^(online|virtual|livestream|live stream|zoom|digital)\b/,
	/^(tba|tbc|to be (announced|confirmed)|location tba|venue tba)\b/,
	/^(across|around|all over) (singapore|the island)\b/,
	/^(singapore|sg)$/,
	/^(home|anywhere|your home)$/,
];

function stripDiacritics(text) {
	return text.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function cleanPunctuation(text) {
	return text
		.replace(/&/g, " and ")
		.replace(/@/g, " at ")
		.replace(/['’`]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// Alias keys retain address, unit and branch details. Similar variants are matched by
// the model, rather than discarding details that distinguish separate chain locations.
export function normalizeVenueName(raw) {
	if (typeof raw !== "string") return "";
	let text = stripDiacritics(raw).toLowerCase().trim();
	text = text.replace(/[()]/g, " ");
	text = cleanPunctuation(text);
	text = text.replace(/^the /, "");
	if (text !== "singapore") {
		text = text.replace(/ singapore$/, "");
	}
	return text;
}

// True for placeholders that should never become a venue ("Various locations", "Online").
export function isVagueVenueName(raw) {
	const normalized = normalizeVenueName(raw);
	return VAGUE_VENUE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function tokenize(normalized) {
	return normalized
		.split(" ")
		.filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

// 0..1 similarity between two normalised strings: the better of token Jaccard and a damped
// containment score (so "national gallery" vs "national gallery st andrews road" still ranks).
export function tokenSimilarity(normalizedA, normalizedB) {
	const tokensA = new Set(tokenize(normalizedA));
	const tokensB = new Set(tokenize(normalizedB));
	if (tokensA.size === 0 || tokensB.size === 0) return 0;
	let shared = 0;
	for (const token of tokensA) {
		if (tokensB.has(token)) shared += 1;
	}
	const jaccard = shared / (tokensA.size + tokensB.size - shared);
	const containment = shared / Math.min(tokensA.size, tokensB.size);
	return Math.max(jaccard, containment * 0.85);
}

// Event titles: lowercase, no diacritics/punctuation, no standalone years ("2026") or
// edition markers, so "Singapore Night Festival 2026" and "Singapore Night Festival" match.
export function normalizeEventTitle(raw) {
	if (typeof raw !== "string") return "";
	let text = stripDiacritics(raw).toLowerCase();
	text = text.replace(/\b(19|20)\d{2}\b/g, " ");
	text = cleanPunctuation(text);
	text = text.replace(/\b(\d+(st|nd|rd|th) edition|edition)\b/g, " ");
	return text.replace(/\s+/g, " ").trim();
}

// URL-safe slug for readable IDs: "National Gallery Singapore" -> "national-gallery-singapore".
export function slugify(raw, maxLength = 48) {
	const text = cleanPunctuation(stripDiacritics(String(raw ?? "")).toLowerCase());
	const slug = text.replace(/ /g, "-").slice(0, maxLength).replace(/-+$/, "");
	return slug || "venue";
}
