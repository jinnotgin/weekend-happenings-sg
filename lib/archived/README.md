# Archived LLM Integrations

The modules in this directory are no longer part of the active scraping
pipeline. They are retained for reference only and should not be imported by
new code. Prefer the REST-based Gemini client (`lib/llm-gemini-rest.js`) and the
fallback orchestrator (`lib/llm-gateway.js`).

- `llm-nim.js`, `test-nim.js`: NVIDIA NIM client and its structured-output smoke
  test, archived 2026-11-14 when NIM was dropped from `LLM_TASK_PREFERENCES`
  (see the MODEL SELECTION RATIONALE block in `lib/constants.js`).
