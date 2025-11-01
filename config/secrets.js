const required = (name, value) => {
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
};

export const GEMINI_API_KEY = required("GEMINI_API_KEY", process.env.GEMINI_API_KEY);
export const OPENAI_API_KEY = required("OPENAI_API_KEY", process.env.OPENAI_API_KEY);

export const GOOGLE_WEB_SEARCH_API_KEY = required(
	"GOOGLE_WEB_SEARCH_API_KEY",
	process.env.GOOGLE_WEB_SEARCH_API_KEY
);
export const GOOGLE_WEB_SEARCH_ENGINE_ID = required(
	"GOOGLE_WEB_SEARCH_ENGINE_ID",
	process.env.GOOGLE_WEB_SEARCH_ENGINE_ID
);

export const R2_ACCOUNT_ID = required("R2_ACCOUNT_ID", process.env.R2_ACCOUNT_ID);
export const R2_BUCKET_NAME = required("R2_BUCKET_NAME", process.env.R2_BUCKET_NAME);
export const R2_ACCESS_KEY_ID = required(
	"R2_ACCESS_KEY_ID",
	process.env.R2_ACCESS_KEY_ID
);
export const R2_SECRET_ACCESS_KEY = required(
	"R2_SECRET_ACCESS_KEY",
	process.env.R2_SECRET_ACCESS_KEY
);

// Optional helpers
export const BING_SEARCH_API_KEY = process.env.BING_SEARCH_API_KEY ?? null;
