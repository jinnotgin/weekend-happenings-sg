# Archived Integrations

The modules in this directory are no longer part of the active scraping
pipeline. They are retained for reference only and should not be imported by
new code. For LLM calls, prefer the REST-based Gemini client
(`lib/llm-gemini-rest.js`) and the fallback orchestrator (`lib/llm-gateway.js`).
For web and image search, use `lib/brave-search.js`.

- `llm-nim.js`, `test-nim.js`: NVIDIA NIM client and its structured-output smoke
  test, archived 2026-11-14 when NIM was dropped from `LLM_TASK_PREFERENCES`
  (see the MODEL SELECTION RATIONALE block in `lib/constants.js`).

- `google-search.js`: Google Custom Search JSON API integration, archived
  2026-11-14 when the pipeline migrated to Brave Search. Google has closed the
  API to new customers and will discontinue it on 2027-01-01; see the
  [official retirement notice](https://developers.google.com/custom-search/v1/overview).
  The original implementation is preserved for reference; its Google credential
  exports are no longer present in `config/secrets.js`.
