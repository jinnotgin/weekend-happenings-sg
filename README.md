# weekend-happenings-sg

End-to-end pipeline for discovering Singapore events, normalising them with LLMs, enriching each event with search metadata, and publishing the results to Cloudflare R2.

## Pipeline overview

- Reset the `data/` workspace at the start of every run.
- Build a URL queue by merging fixed sources with Brave Search results (optional) and filtering out blacklisted domains.
- Scrape each URL with Puppeteer (with robust retries and HTTP fallbacks) and persist the raw text snapshots under `data/tmp/`.
- Extract structured event JSON, deduplicate titles, and consolidate unique events using per-task Gemini/OpenRouter model preferences and prompt templates in `lib/prompts/`. The OpenAI provider is also supported.
- Resolve venues and match events against a persistent registry to assign stable IDs. Exact aliases retain branch and address details; uncertain matches use the registry matching models.
- Enrich venue locations and generate human-friendly date ranges, reusing stored enrichment where applicable.
- Resolve event links and thumbnails using Brave Search, or download a matched event's existing thumbnail from R2.
- Write the compiled payload to `data/compiled/`, then push both a `latest/` copy and a timestamped archive to the configured Cloudflare R2 bucket (old archives are pruned beyond the most recent 30 runs).
- Save structured JSON logs under `logs/runs/<runId>/` and stream progress to the console according to the configured log level.

## Requirements

- Node.js 24 (matches the scheduled workflow and supports the built-in `node:sqlite` registry and tests)
- npm (included with Node.js)
- API access:
  - Google Gemini (REST API key; multiple keys supported for quota rotation)
  - OpenRouter API
  - OpenAI API (optional; the `openai` provider is supported but not in the default preferences)
  - Brave Search API (subscription token)
  - Cloudflare R2 bucket with S3-compatible credentials
  - Cloudflare D1 database and API token for stable registry storage on ephemeral runners; local development can use SQLite
  - Optional: Bing Search API (only if you reinstate the Bing helper)

## Installation

```bash
npm install
```

If you deploy to Google Cloud Run/App Engine, run `npm run gcp-build` during the build step so Puppeteer can download Chromium once.

## Environment configuration

Create a `.env` in the repository root. `dotenv/config` loads it automatically.

| Variable | Required | Notes |
| --- | --- | --- |
| `GEMINI_API_KEYS` | Yes (unless `GEMINI_API_KEY` provided) | Comma or newline separated list. You can also use `GEMINI_API_KEY` or numbered variants (`GEMINI_API_KEY_1=...`). The first key becomes primary and the rest are used when quota is exhausted. |
| `OPENAI_API_KEY` | Conditionally | Required when any task preference uses provider `openai`. |
| `OPENROUTER_API_KEY` | Conditionally | Required when any task preference uses provider `openrouter`. |
| `BRAVE_SEARCH_API_KEY` | Yes | Brave Search API subscription token with web and image search access. |
| `R2_ACCOUNT_ID` | Yes | Cloudflare account ID. |
| `R2_BUCKET_NAME` | Yes | Target bucket containing `latest/` and `archive-*` folders. |
| `R2_ACCESS_KEY_ID` | Yes | S3 access key for R2. |
| `R2_SECRET_ACCESS_KEY` | Yes | S3 secret key for R2. |
| `D1_DATABASE_ID` | For a D1 registry | Database ID; use a separate development database locally. |
| `D1_API_TOKEN` | For a D1 registry | Cloudflare API token with D1 Edit permission. |
| `CLOUDFLARE_ACCOUNT_ID` | No | D1 account ID; defaults to `R2_ACCOUNT_ID`. |
| `REGISTRY_SQLITE_PATH` | No | Local registry path when D1 configuration is incomplete; defaults to `.registry/registry.sqlite`. |
| `PERFORM_WEB_SEARCH` | No (default `true`) | Set to `false` to skip Brave search discovery and rely only on `FIXED_URLS_TO_SCRAPE`. |
| `NODE_ENV` | No | Console logging defaults to `error` in production and `info` otherwise. |
| `LOG_CONSOLE_LEVEL` | No | Overrides console verbosity. The scheduled workflow uses `info`. |
| `LOG_RETENTION_RUNS` | No (default `10`) | Number of run log directories to retain locally. |

> ⚠️ The run starts by deleting the entire `data/` directory (`lib/diskio.js`). Do not store anything you want to keep there.

## Brave Search

Set `BRAVE_SEARCH_API_KEY` locally and as a GitHub Actions repository secret. Google
Custom Search credentials and engine IDs are no longer used. Obtain a token from
[Brave's API dashboard](https://api-dashboard.search.brave.com/), with access to
both [web search](https://api-dashboard.search.brave.com/api-reference/web/search/get)
and [image search](https://api-dashboard.search.brave.com/api-reference/images/image_search).

Search uses Singapore (`country=SG`), English, and strict SafeSearch. Discovery
requests up to two ten-result pages for each of the three search terms, deduplicates
URLs, and stops when Brave reports no more results. Requests are paced at least
1.1 seconds apart across discovery and enrichment to accommodate a 1-request/second
subscription; web-search HTTP failures propagate to the pipeline's existing retry helper.

Event enrichment first downloads non-logo thumbnails from ranked web results,
preferring original images. If fewer than the configured candidate limit download
successfully, a separate image search supplies additional candidates. The existing
vision selection still chooses the final thumbnail. Image candidates retain both
the image URL (`sourceUrl`) and its source page (`pageUrl`). Dedicated image search
can return older editions or other countries, so include identifying edition/year
information in event titles where available. Missing images do not discard event
links, including when image search is unavailable. Cached event thumbnails still bypass search.

`PERFORM_WEB_SEARCH=false` skips discovery only; enrichment still requires Brave.
A normal uncached event uses one web request and at most one additional image-search
request per attempt. Discovery uses up to six requests per run. Check the account's
current allowance before live runs; this migration does not change billing settings.

## Running the pipeline

```bash
node start.js
```

`start.js` wraps `main()` from `index.js` and logs any top-level failures via Winston. Successful runs produce:

```
data/
  tmp/
    raw_<n>.txt                # scraped text snapshots
    json_<n>.txt               # LLM parsed JSON per source
    unique_events.json
    unique_events_data.json
  image-candidates/
    <search slug>-<id>/
      <image assets>.jpg|png   # per-event candidate pools (kept for review)
  compiled/
    events.json                # final consolidated payload
    venues.json                # active venues and merged-ID redirects, when registry is available
    sources.json               # URLs & titles scraped this run
    generationTime.json        # ISO timestamp
    <image assets>.jpg|png     # thumbnails from search or reused from R2
.registry/
  registry.sqlite              # local fallback registry; retained across runs
logs/
  runs/
    <runId>/
      combined.log
      error.log
      summary.log
```

The `compiled/` folder is uploaded to Cloudflare R2 and mirrored to both `latest/` and an `archive-YYYYMMDD-HHMMSS/` folder. Older archives beyond the most recent 30 runs are automatically deleted.
Candidate pools are staged separately under `data/image-candidates/` in per-search subfolders so you can review the raw downloads without uploading them.

## Venue and event registry

When `D1_DATABASE_ID`, `D1_API_TOKEN`, and a Cloudflare account ID are configured, the registry uses D1. Otherwise it uses the local SQLite file, outside the cleared `data/` workspace. The schema in [`db/schema.sql`](db/schema.sql) is applied automatically.

Use D1 for scheduled runs: GitHub-hosted runners are ephemeral, so their local SQLite files do not carry identities into the next run. If opening the registry fails, the pipeline continues without stable IDs or `venues.json`. Once the registry is open, identities must be saved before replacing the public feed; a save failure stops publication. Thumbnail archive keys are updated separately after upload, only for uploaded files.

Registry-backed events include `id` and `first_seen`; locations include `venue_id` and `venue_name`. The companion frontend uses venue IDs for saved venues and follows the redirects published in `venues.json` when duplicate venues are merged.

Inspect and maintain the configured registry with:

```bash
npm run registry -- stats
npm run registry -- venues gallery
npm run registry -- venue <id>
npm run registry -- merge <duplicate-id> <surviving-id>
npm run registry -- rename <id> <new name>
npm run registry -- alias <id> <alternate name>
```

The merge, rename, and alias commands update the database. Public venue names and redirects are refreshed by the next successful pipeline publication.

## Tests and scheduled runs

```bash
npm test
```

Tests use in-memory SQLite and mocked model/R2 calls, with placeholder credentials supplied by `test/setup-env.js`.

The GitHub Actions workflow runs on Tuesdays and Thursdays at 01:33 Singapore time and also supports manual runs. See [`docs/github-actions.md`](docs/github-actions.md) for secrets, D1 setup, and operation details. Running the pipeline publishes to the configured R2 bucket.

## Customising behaviour

Most knobs live in `lib/constants.js`:

- `FIXED_URLS_TO_SCRAPE` seeds the crawler with known event feeds.
- `SCRAPER_OPTIONS.PERFORM_WEB_SEARCH` reads from `PERFORM_WEB_SEARCH` to control Google discovery.
- `SEARCH_TERM_FOR_EVENTS` is expanded into several monthly/weekend search phrases.
- `BLACKLISTED_DOMAINS` filters out noisy hosts before scraping.
- `PROMPT_TEMPLATES` load text instructions from `lib/prompts/` for parsing, deduping, consolidation, registry matching, venue location, date ranges, and image selection. Tweak these to change LLM behaviour.
- `LLM_TASK_PREFERENCES` configures provider/model fallback order per pipeline stage, including `REGISTRY_MATCHING` for venue and event identity decisions. Supported providers are `gemini`, `openrouter`, and `openai`. Entries may carry `OPTIONS: { REASONING_EFFORT }` (mapped to OpenRouter `reasoning.effort` or Gemini `thinkingLevel`). For OpenRouter, use provider-qualified model IDs (e.g. `openai/gpt-6-luna`). The dated "MODEL SELECTION RATIONALE" comment in that file explains the current choices and how to re-evaluate them.
- `EVENT_CATEGORY_GUIDANCE`, `REGION_GUIDANCE`, and MRT naming helpers are embedded into the prompts to encourage consistent metadata.

The crawler itself is implemented in `lib/crawler.js` using `puppeteer-extra` with the stealth plugin and an HTTP fallback path for JSON APIs. Update that file if you need different scraping heuristics or headers.

## Troubleshooting

- **Quota limits**: Gemini requests rotate through any keys listed in `GEMINI_API_KEYS` when the free-tier cap is reached. Review `logs/runs/<runId>/combined.log` for rotation messages.
- **Missing or changing IDs**: Check registry startup logs and the D1 configuration. SQLite identities persist only where the database file is retained between runs.
- **Search failures**: Set `PERFORM_WEB_SEARCH=false` to run with only fixed URLs, or update the `BRAVE_SEARCH_API_KEY` credential.
- **Upload issues**: Check Cloudflare credentials and confirm the bucket exists. Failed uploads leave data in `data/compiled/` for manual inspection.
- **Puppeteer timeouts**: The crawler catches transient errors and retries with back-off; persistent issues will be logged with the offending URL for manual debugging.
