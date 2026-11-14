import fs from "node:fs";
import path from "node:path";

// Two interchangeable SQL executors with the same tiny interface:
//   all(sql, params)  -> rows
//   batch([{ sql, params }]) -> void, applied in one atomic unit where the backend allows
//   describe()        -> short label for logs
// Cloudflare D1 is the durable store for production; the local SQLite file is for development
// and for runs where D1 is not configured (its IDs then only persist on that machine).

const D1_API_BASE = "https://api.cloudflare.com/client/v4";
// Keep request bodies modest; D1 caps statement size and request duration.
const D1_MAX_STATEMENTS_PER_REQUEST = 50;
const D1_TIMEOUT_MS = 30_000;

export function createD1Executor({ accountId, databaseId, apiToken, fetchImpl = fetch }) {
	if (!accountId || !databaseId || !apiToken) {
		throw new Error("D1 executor needs accountId, databaseId and apiToken");
	}
	const url = `${D1_API_BASE}/accounts/${accountId}/d1/database/${databaseId}/query`;

	async function post(body) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), D1_TIMEOUT_MS);
		try {
			const response = await fetchImpl(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			const payload = await response.json().catch(() => null);
			if (!response.ok || !payload?.success) {
				const message =
					payload?.errors?.map((error) => `${error.code}: ${error.message}`).join("; ") ||
					`HTTP ${response.status}`;
				throw new Error(`D1 query failed: ${message}`);
			}
			return Array.isArray(payload.result) ? payload.result : [];
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		describe: () => `Cloudflare D1 (${databaseId.slice(0, 8)}…)`,
		async all(sql, params = []) {
			const [first] = await post({ sql, params });
			return Array.isArray(first?.results) ? first.results : [];
		},
		async batch(statements = []) {
			// Each request is one D1 batch. Statements are idempotent upserts, so a run that
			// fails between chunks leaves a consistent (if partially updated) registry.
			for (let index = 0; index < statements.length; index += D1_MAX_STATEMENTS_PER_REQUEST) {
				const chunk = statements.slice(index, index + D1_MAX_STATEMENTS_PER_REQUEST);
				await post({
					batch: chunk.map(({ sql, params = [] }) => ({ sql, params })),
				});
			}
		},
	};
}

export async function createSqliteExecutor(filePath) {
	const { DatabaseSync } = await import("node:sqlite");
	if (filePath !== ":memory:") {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
	}
	const database = new DatabaseSync(filePath);
	database.exec("PRAGMA foreign_keys = ON;");

	// node:sqlite returns null-prototype objects; normalise to plain objects.
	const toPlain = (row) => ({ ...row });

	return {
		describe: () => `local SQLite (${filePath})`,
		async all(sql, params = []) {
			return database.prepare(sql).all(...params).map(toPlain);
		},
		async batch(statements = []) {
			database.exec("BEGIN");
			try {
				for (const { sql, params = [] } of statements) {
					database.prepare(sql).run(...params);
				}
				database.exec("COMMIT");
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
		async exec(sql) {
			database.exec(sql);
		},
		close() {
			database.close();
		},
	};
}

// Picks D1 when its env vars are present, else a local SQLite file.
// Env: D1_DATABASE_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (falls back to R2_ACCOUNT_ID,
// the same Cloudflare account), REGISTRY_SQLITE_PATH (default .registry/registry.sqlite; not under
// data/, which every run wipes).
export async function createExecutorFromEnv(env = process.env) {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID || env.R2_ACCOUNT_ID;
	const databaseId = env.D1_DATABASE_ID;
	const apiToken = env.CLOUDFLARE_API_TOKEN;

	if (databaseId && apiToken && accountId) {
		return { executor: createD1Executor({ accountId, databaseId, apiToken }), durable: true };
	}

	const sqlitePath = env.REGISTRY_SQLITE_PATH || path.resolve(".registry", "registry.sqlite");
	return { executor: await createSqliteExecutor(sqlitePath), durable: false };
}
