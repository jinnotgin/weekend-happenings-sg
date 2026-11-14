import fs from "node:fs";
import path from "node:path";
import { createLogger, format, transports } from "winston";

const RUNS_ROOT = path.join("logs", "runs");
const DEFAULT_RETENTION_RUNS = 10;
const retentionRuns = Number.parseInt(
	process.env.LOG_RETENTION_RUNS ?? "",
	10
);

const resolvedRetentionRuns = Number.isFinite(retentionRuns)
	? retentionRuns
	: DEFAULT_RETENTION_RUNS;

function formatRunId(date = new Date()) {
	const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(
		date.getDate()
	).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(
		date.getMinutes()
	).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
	return `${stamp}-${process.pid}`;
}

const runId = formatRunId();
const runDir = path.join(RUNS_ROOT, runId);

function ensureLogDirectories() {
	fs.mkdirSync(runDir, { recursive: true });
}

function cleanupOldRuns() {
	if (!fs.existsSync(RUNS_ROOT)) {
		return;
	}

	const entries = fs.readdirSync(RUNS_ROOT, { withFileTypes: true });
	const runDirs = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const fullPath = path.join(RUNS_ROOT, entry.name);
			let mtimeMs = 0;
			try {
				mtimeMs = fs.statSync(fullPath).mtimeMs;
			} catch {
				return null;
			}
			return { name: entry.name, fullPath, mtimeMs };
		})
		.filter(Boolean);

	if (runDirs.length <= resolvedRetentionRuns) {
		return;
	}

	runDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const staleRuns = runDirs.slice(resolvedRetentionRuns);

	for (const run of staleRuns) {
		fs.rmSync(run.fullPath, { recursive: true, force: true });
	}
}

ensureLogDirectories();
cleanupOldRuns();

const summaryFilter = format((info) => {
	if (info.level === "error" || info.level === "warn" || info.summary) {
		return info;
	}
	return false;
});

const logger = createLogger({
	level: "info",
	format: format.combine(
		format.timestamp({
			format: "YYYY-MM-DD HH:mm:ss",
		}),
		format.errors({ stack: true }),
		format.splat(),
		format.json()
	),
	defaultMeta: { service: "weekend-happenings-sg-main", runId },
	transports: [
		//
		// - Write all logs with importance level of `error` or less to `error.log`
		// - Write all logs with importance level of `info` or less to `combined.log`
		// - Write summary events (warn/error + explicit summary) to `summary.log`
		//
		new transports.File({
			filename: path.join(runDir, "error.log"),
			level: "error",
			maxsize: 1 * 1024 * 1024,
			maxFiles: 10,
		}),
		new transports.File({
			filename: path.join(runDir, "combined.log"),
			maxsize: 1 * 1024 * 1024,
			maxFiles: 10,
		}),
		new transports.File({
			filename: path.join(runDir, "summary.log"),
			format: format.combine(summaryFilter(), format.json()),
			maxsize: 1 * 1024 * 1024,
			maxFiles: 10,
		}),
	],
});

// Console verbosity: LOG_CONSOLE_LEVEL (error|warn|info|debug) overrides the default,
// which is "error" in production and "info" otherwise. CI (GitHub Actions) sets it to
// "info" so stage-by-stage progress streams into the job log; full logs always go to
// the files under logs/runs/ regardless of this setting.
const CONSOLE_LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"];
const requestedConsoleLevel = process.env.LOG_CONSOLE_LEVEL?.trim().toLowerCase();
const consoleLevel = CONSOLE_LEVELS.includes(requestedConsoleLevel)
	? requestedConsoleLevel
	: process.env.NODE_ENV === "production"
		? "error"
		: "info";

logger.add(
	new transports.Console({
		level: consoleLevel,
		format: format.combine(format.colorize(), format.simple()),
	})
);

logger.summary = (message, meta = {}) =>
	logger.info(message, { ...meta, summary: true });

export default logger;
