// Tests never call real LLMs or R2, but importing pipeline modules loads config/secrets.js,
// which requires these variables. Fill harmless placeholders when they are unset.
const placeholders = [
	"GEMINI_API_KEY",
	"OPENAI_API_KEY",
	"OPENROUTER_API_KEY",
	"GOOGLE_WEB_SEARCH_API_KEY",
	"GOOGLE_WEB_SEARCH_ENGINE_ID",
	"R2_ACCOUNT_ID",
	"R2_BUCKET_NAME",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
];
for (const name of placeholders) {
	if (!process.env[name] && !(name === "GEMINI_API_KEY" && process.env.GEMINI_API_KEYS)) {
		process.env[name] = "test-placeholder";
	}
}
// Never let tests talk to a real D1 database.
delete process.env.D1_DATABASE_ID;
delete process.env.CLOUDFLARE_API_TOKEN;
