const parseEnvList = (value) =>
	value
		.split(/[,\n]/)
		.map((item) => item.trim())
		.filter(Boolean);

const resolveGeminiApiKeys = () => {
	const keys = new Set();

	const multiKeyValue = process.env.GEMINI_API_KEYS;
	if (typeof multiKeyValue === "string" && multiKeyValue.trim()) {
		for (const entry of parseEnvList(multiKeyValue)) {
			keys.add(entry);
		}
	}

	const singleKeyValue = process.env.GEMINI_API_KEY;
	if (typeof singleKeyValue === "string" && singleKeyValue.trim()) {
		keys.add(singleKeyValue.trim());
	}

	for (const [envName, value] of Object.entries(process.env)) {
		if (!envName.startsWith("GEMINI_API_KEY_")) continue;
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed) keys.add(trimmed);
	}

	const uniqueKeys = Array.from(keys);

	return uniqueKeys;
};

const GEMINI_API_KEYS_INTERNAL = resolveGeminiApiKeys();

export const GEMINI_API_KEYS = GEMINI_API_KEYS_INTERNAL;
export const GEMINI_API_KEY = GEMINI_API_KEYS_INTERNAL[0];
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? null;
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? null;
export const NIM_API_KEY = process.env.NIM_API_KEY ?? null;

// Read credentials lazily at the operation boundary. Missing optional providers
// must not prevent another provider or a credential-free test from starting.
export const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY ?? null;
export const GOOGLE_WEB_SEARCH_API_KEY = process.env.GOOGLE_WEB_SEARCH_API_KEY ?? null;
export const GOOGLE_WEB_SEARCH_ENGINE_ID = process.env.GOOGLE_WEB_SEARCH_ENGINE_ID ?? null;
export const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? null;
export const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? null;
export const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? null;
export const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? null;
export const BING_SEARCH_API_KEY = process.env.BING_SEARCH_API_KEY ?? null;
