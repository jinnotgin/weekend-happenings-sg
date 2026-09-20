# weekend-happenings-sg

Batch pipeline for discovering Singapore events, extracting structured records,
resolving venue details, selecting thumbnails, and publishing JSON/images to R2.

## Model routing

Each row is tried left to right. Errors, truncated responses, invalid JSON, and
schema/semantic validation failures advance to the next route. Missing provider
credentials fail that route, rather than crashing imports for all providers.

| Task | Priority |
| --- | --- |
| Extract events | OpenRouter Gemma 4 free → NVIDIA Gemma 4 → GPT-5.6 Luna → OpenRouter GPT-OSS 120B Exacto → Gemini 3.8 Flash |
| Deduplicate events | OpenRouter Gemma 4 free → NVIDIA Gemma 4 → GPT-5.6 Luna → OpenRouter GPT-OSS 120B Exacto → Gemini 3.8 Flash |
| Consolidate records | GPT-5.6 Luna → OpenRouter GPT-OSS 120B Exacto → Gemini 3.8 Flash |
| Normalize dates | OpenRouter Gemma 4 free → NVIDIA Gemma 4 → GPT-5.6 Luna → OpenRouter Gemma 4 paid |
| Select thumbnails | OpenRouter Gemma 4 free → NVIDIA Gemma 4 → Gemini 3.8 Flash → OpenRouter Gemma 4 paid |
| Enrich venue locations | Gemini 3.8 Flash only; unresolved fields remain null |

Exact IDs: `google/gemma-4-31b-it:free` and `google/gemma-4-31b-it` on
OpenRouter, `google/gemma-4-31b-it` on NVIDIA, `gpt-5.6-luna` on OpenAI,
`openai/gpt-oss-120b:exacto` on OpenRouter, and `gemini-3.8-flash` on Google.
NVIDIA's free endpoint is a trial/quota-based service; availability is not guaranteed.

Extraction copies source venue names only. Consolidation merges those names and
leaves geographic fields null. A separate Gemini step receives Brave evidence
for each distinct venue and fills region/GPS/MRT only when supported. Maps search
URLs are generated in code. No Google grounding tool is used.

OpenRouter free uses JSON object mode; NIM Gemma is prompted with the schema
without sending an undocumented `response_format`. Paid OpenRouter and OpenAI
use JSON schemas. AJV checks the original schema locally for all routes. Truncated
responses are rejected rather than recursively requesting/stitching continuations.
Luna uses `reasoning_effort: none`; Gemma thinking is disabled, GPT-OSS uses low
reasoning, and Gemini uses minimal thinking. Responses are capped at 16,384 tokens
by default (1,024 for dates/images, 2,048 for location enrichment).

The OpenAI adapter retains Chat Completions and the existing SDK; it sends no
function tools or unconditional sampling/penalty parameters. It uses native fetch
explicitly. Older model constants and archived clients remain as historical code,
but are absent from active task routes.

## Setup

Use Node.js 22+ (Actions pins Node 24).

```sh
npm ci
npx puppeteer browsers install chrome --install-deps
```

Create `.env` with the variables from `.env.example`. Search discovery and event
link/image/location enrichment now use Brave. No Google Custom Search credentials
are needed for the active pipeline. For all fallback routes, configure all four
model providers. A missing Gemini key leaves location enrichment null; missing
all text providers prevents a useful run.

Brave plan selection must cover storage of the result metadata used in R2 and any
persistent caching. API access does not grant rights to third-party images. This
implementation only caches search responses in memory within a run. See
[Brave's storage FAQ](https://brave.com/search/api/).

## Run modes

```sh
npm start                         # dry-run: makes API calls, writes local results, no R2
PUBLISH_MODE=staging npm start     # writes staging/latest and staging/archive-* in R2
PUBLISH_MODE=production npm start  # writes latest and archive-* in R2
npm test                          # offline, mocked provider/search/storage tests
```

The entry point uses `Asia/Singapore` time and a 150-minute runtime budget. Each
run clears `data/`; do not put durable inputs there. API calls may incur charges
in all three run modes. `PERFORM_WEB_SEARCH=false` skips discovery only; Brave is
still used for enrichment.

Pipeline stages:
1. Merge fixed sources with three Brave queries, up to 20 results each; deduplicate
   URLs and apply the existing blacklist. Freshness filters are not forced because
   page publication date is not event date.
2. Scrape sequentially with Puppeteer, bounded retries, and HTTP fallback. Parse
   per-source records and assign contiguous source indices to successful sources.
3. Deduplicate and consolidate in batches of 30 events. The full source context is
   still supplied to each consolidation batch to preserve matching behavior.
4. Enrich distinct venue names with Gemini and Brave evidence, normalize dates,
   and resolve event links/thumbnails. Link ranking is heuristic, not proof that a
   URL is official. Prefer the selected page's OG/Twitter image; request Brave image
   candidates when it has no usable image. Thumbnail failure does not discard a link.
5. Write `data/compiled/{events,sources,generationTime}.json` and thumbnail files.
   Raw snapshots and `run-summary.json` live under `data/tmp`; logs under `logs/runs`.
6. Validate coverage before publishing. Upload and HEAD-verify every immutable
   archive object, upload latest images/metadata, then replace `latest/events.json`
   last. Never delete the old latest dataset before uploading.

Publication is not an atomic transaction across all R2 keys: `events.json` is the
commit point for frontend event records, but metadata can briefly precede it.
Old latest images are deliberately retained so readers with cached old events
keep working. Archive retention is 30 runs; retained latest images currently need
separate garbage collection. Existing frontend URLs and event field names remain
compatible. Coordinate/MRT inference is evidence-based but still needs human QA.

## Budgets and publication gates

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_RUN_MINUTES` | 150 | Whole-process deadline |
| `MAX_BRAVE_REQUESTS_PER_RUN` | 500 | Includes retries; cache hits do not count |
| `MAX_LLM_REQUESTS_PER_RUN` | 1000 | Caps requests across providers |
| `MIN_EVENTS` | 1 | Absolute event minimum; set to your normal baseline |
| `MIN_SOURCES` | 1 | Absolute successful-source minimum |
| `MIN_SOURCE_SUCCESS_RATIO` | 0.5 | Successful extraction / attempted source URLs |
| `MIN_EVENT_RETENTION_RATIO` | 0.5 | New count / prior published count, per destination |

All model requests have a 90-second timeout. Search/body downloads and R2 operations
also have deadlines; image downloads are capped at 3 MB. Per-task/model request and
token counters are included in the run summary; Gemini thinking tokens are separate,
while OpenAI completion tokens already include reasoning. These are usage counters,
not a dollar estimate. Provider prices, quotas and reasoning consumption can change.
Fatal errors and publication failures set a nonzero process exit status. Empty or
low-coverage results are kept locally for diagnosis and are not published.

## GitHub Actions rollout

`.github/workflows/test.yml` runs credential-free tests on pushes and PRs.
`.github/workflows/scrape.yml` supports manual dry-run/staging/production runs.
The daily schedule is 06:17 Singapore time and only operates from the default
branch after merge, when repository variable `AUTO_SCRAPE_ENABLED=true`.
Scheduled runs default to staging; set `SCRAPER_PUBLISH_MODE=production` after
validation. A global concurrency group prevents overlapping workflow publishers.
Disable any old external production scheduler before enabling this one.

Configure repository secrets: `BRAVE_SEARCH_API_KEY`, `OPENROUTER_API_KEY`,
`NIM_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (or comma/newline-separated
`GEMINI_API_KEYS`), `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and
`R2_SECRET_ACCESS_KEY`. Budget and minimum-count variables above can also be set as
repository variables. R2 credentials need read/list/write and archive-delete access.

First run manual dry-run, then staging. Inspect extracted event counts, dates,
coordinates, MRTs, source coverage, image matches, actual token use and runner
runtime. The local test suite does not demonstrate live provider availability,
Brave Singapore coverage, production quality, or scraping success from runner IPs.
GitHub schedules may be delayed; use the published generation timestamp to monitor
freshness. Run artifacts (logs, summary, compiled files) expire after seven days.

OpenAI request compatibility was reviewed using model documentation and bundled
migration guidance; the live migration-guide resource was unavailable.

## API references

- [OpenRouter Gemma 4 free](https://openrouter.ai/google/gemma-4-31b-it:free)
- [NVIDIA Gemma 4 request contract](https://docs.api.nvidia.com/nim/reference/google-gemma-4-31b-it-infer)
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Brave web search](https://api-dashboard.search.brave.com/api-reference/web/search/get)
- [Brave image search](https://api-dashboard.search.brave.com/app/documentation/image-search/get-started)
