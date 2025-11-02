# weekend-happenings-sg

Scripted pipeline that scrapes Singapore event listings, deduplicates them with LLMs, enriches each event with search metadata, and publishes the output to Cloudflare R2.

## Requirements
- Node.js 20+ (top-level await, built-in `fetch`, and the latest Puppeteer require a modern runtime)
- npm 9+ (comes with Node 20)
- API access:
  - Google Custom Search (key + CX)
  - Google Gemini API
  - OpenAI API
  - Cloudflare R2 bucket (for publishing results)

## Setup
1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Add environment variables**  
   Create a `.env` file in the repository root (loaded automatically via `dotenv/config`):
   ```ini
   GEMINI_API_KEY=your_gemini_key
   OPENAI_API_KEY=your_openai_key
   GOOGLE_WEB_SEARCH_API_KEY=your_google_search_key
   GOOGLE_WEB_SEARCH_ENGINE_ID=your_search_cx
   R2_ACCOUNT_ID=your_r2_account_id
   R2_BUCKET_NAME=your_r2_bucket
   R2_ACCESS_KEY_ID=your_r2_access_key
   R2_SECRET_ACCESS_KEY=your_r2_secret_key

   # Optional: set to false to skip Google web searches
   PERFORM_WEB_SEARCH=true

   # Optional: only needed if you switch back to the Bing helper
   BING_SEARCH_API_KEY=your_bing_key
   ```

3. **(First run on GCP) Install Chrome dependencies**  
   If you deploy to Google Cloud with a build step, run `npm run gcp-build` once so Puppeteer downloads the Chromium bundle.

## Running the pipeline
- Local run:
  ```bash
  node start.js
  ```
- The run will:
  - Clear the `data/` directory.
  - Scrape event listings from the configured sources (`lib/constants.js`).
  - Ask Gemini/OpenAI to normalise and deduplicate events.
  - Use Google Custom Search to fetch canonical links and thumbnails.
  - Write intermediate files to `data/tmp/` and the final payload to `data/compiled/`.
  - Upload the compiled output to your Cloudflare R2 bucket (both `latest/` and a timestamped archive folder).

Logs are written to the console and to rotating files in `logs/`.

## Customisation
- Adjust `SERACH_TERM_FOR_EVENTS`, `BLACKLISTED_DOMAINS`, the static `FIXED_URLS_TO_SCRAPE`, or toggle the `PERFORM_WEB_SEARCH` environment variable (see `lib/constants.js`) to target different queries.
- Update `PROMPT_TEMPLATES` in the same file to tweak how the LLM summarises and deduplicates events.
 
