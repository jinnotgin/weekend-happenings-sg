# weekend-happenings-sg

End-to-end pipeline for discovering Singapore events, normalising them with LLMs, enriching each event with search metadata, and publishing the results to Cloudflare R2.

## Pipeline overview
- Reset the `data/` workspace at the start of every run.
- Build a URL queue by merging fixed sources with Google Custom Search results (optional) and filtering out blacklisted domains.
- Scrape each URL with Puppeteer (with robust retries and HTTP fallbacks) and persist the raw text snapshots under `data/tmp/`.
- Use Gemini (with OpenAI fallback) to extract structured event JSON, deduplicate titles, and consolidate unique events via prompt templates in `lib/prompts/`.
- Generate human-friendly date ranges from the LLM datetime values.
- Resolve canonical links and thumbnails for each event using Google Custom Search, saving images alongside compiled JSON.
- Write the compiled payload to `data/compiled/`, then push both a `latest/` copy and a timestamped archive to the configured Cloudflare R2 bucket (old archives are pruned beyond the most recent 30 runs).
- Stream JSON logs to the console and rotate them to `logs/combined.log` and `logs/error.log`.

## Requirements
- Node.js 20+ (for `fetch`, top-level await, and current Puppeteer releases)
- npm 9+ (bundled with Node 20)
- API access:
  - Google Gemini (REST API key; multiple keys supported for quota rotation)
  - OpenAI API
  - OpenRouter API
  - NVIDIA NIM API (optional, for `nim` provider preferences)
  - Google Custom Search API (key + CX/engine ID)
  - Cloudflare R2 bucket with S3-compatible credentials
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
| `NIM_API_KEY` | Conditionally | Required when any task preference uses provider `nim`. |
| `GOOGLE_WEB_SEARCH_API_KEY` | Yes | Google Custom Search API key. |
| `GOOGLE_WEB_SEARCH_ENGINE_ID` | Yes | The Custom Search CX/engine ID. |
| `R2_ACCOUNT_ID` | Yes | Cloudflare account ID. |
| `R2_BUCKET_NAME` | Yes | Target bucket containing `latest/` and `archive-*` folders. |
| `R2_ACCESS_KEY_ID` | Yes | S3 access key for R2. |
| `R2_SECRET_ACCESS_KEY` | Yes | S3 secret key for R2. |
| `PERFORM_WEB_SEARCH` | No (default `true`) | Set to `false` to skip Google search discovery and rely only on `FIXED_URLS_TO_SCRAPE`. |
| `BING_SEARCH_API_KEY` | No | Only used if you swap back to the Bing helper. |
| `NODE_ENV` | No | Controls console logging verbosity; any non-production value logs all levels. |

> ⚠️ The run starts by deleting the entire `data/` directory (`lib/diskio.js`). Do not store anything you want to keep there.

## Running the pipeline
```bash
node start.js
```

Resume from a specific phase:

```bash
node start.js --start-phase <phase>
```

Available phases:
- `scrape` (default): full run from scratch, including clearing `data/`
- `unique`: start from unique-event deduplication (expects `data/tmp/json_*.txt`)
- `consolidate`: start from event consolidation (expects `data/tmp/unique_events.json`)
- `enrich`: start from date/link/thumbnail enrichment (expects `data/tmp/unique_events_data.json`)
- `compile`: write/upload compiled artifacts only (expects `data/compiled/events.json`)

Use `node start.js --help` to print CLI usage.

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
    sources.json               # URLs & titles scraped this run
    generationTime.json        # ISO timestamp
    <image assets>.jpg|png     # thumbnails saved from search
logs/
  combined.log
  error.log
```

The `compiled/` folder is uploaded to Cloudflare R2 and mirrored to both `latest/` and an `archive-YYYYMMDD-HHMMSS/` folder. Older archives beyond the most recent 30 runs are automatically deleted.
Candidate pools are staged separately under `data/image-candidates/` in per-search subfolders so you can review the raw downloads without uploading them.

## Customising behaviour
Most knobs live in `lib/constants.js`:
- `FIXED_URLS_TO_SCRAPE` seeds the crawler with known event feeds.
- `SCRAPER_OPTIONS.PERFORM_WEB_SEARCH` reads from `PERFORM_WEB_SEARCH` to control Google discovery.
- `SEARCH_TERM_FOR_EVENTS` is expanded into several monthly/weekend search phrases.
- `BLACKLISTED_DOMAINS` filters out noisy hosts before scraping.
- `PROMPT_TEMPLATES` load markdown instructions from `lib/prompts/` for the parsing, deduping, consolidation, and date range stages. Tweak these to change LLM behaviour.
- `LLM_TASK_PREFERENCES` configures provider/model priority per pipeline stage (e.g., Gemini/OpenRouter/NIM/OpenAI combinations for parsing, consolidation, date ranges, and thumbnail image selection). Supported providers are `gemini`, `openai`, `openrouter`, and `nim`. For OpenRouter/NIM, use provider-qualified model IDs (examples: `mistralai/mistral-small-3.1-24b-instruct:free`, `meta/llama-3.1-70b-instruct`).
- `EVENT_CATEGORY_GUIDANCE`, `REGION_GUIDANCE`, and MRT naming helpers are embedded into the prompts to encourage consistent metadata.

The crawler itself is implemented in `lib/crawler.js` using `puppeteer-extra` with the stealth plugin and an HTTP fallback path for JSON APIs. Update that file if you need different scraping heuristics or headers.

## Troubleshooting
- **Quota limits**: Gemini requests rotate through any keys listed in `GEMINI_API_KEYS` when the free-tier cap is reached. Review `logs/combined.log` for rotation messages.
- **Search failures**: Set `PERFORM_WEB_SEARCH=false` to run with only fixed URLs, or update `GOOGLE_WEB_SEARCH_*` credentials.
- **Upload issues**: Check Cloudflare credentials and confirm the bucket exists. Failed uploads leave data in `data/compiled/` for manual inspection.
- **Puppeteer timeouts**: The crawler catches transient errors and retries with back-off; persistent issues will be logged with the offending URL for manual debugging.
