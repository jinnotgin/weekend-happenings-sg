# Running the pipeline on GitHub Actions

The workflow in [`.github/workflows/update-events.yml`](../.github/workflows/update-events.yml) runs the full pipeline (`node start.js`) on a GitHub-hosted Ubuntu runner and publishes to R2 exactly like a local run.

- **Schedule:** Tuesday and Thursday, 01:33 Singapore time (`33 17 * * 1,3` in UTC).
- **Manual runs:** Actions tab → *Update weekend happenings* → *Run workflow*.
- **Cost:** free on the GitHub Free plan if runs stay under about 200 min (see [Minutes budget](#minutes-budget)).

---

## 1. One-time setup

### 1.1 Add repository secrets

Go to **Repo → Settings → Secrets and variables → Actions → Secrets → New repository secret** and add:

| Secret | Required? | Value |
| --- | --- | --- |
| `GEMINI_API_KEYS` | Yes | Same as in `.env`. Separate multiple keys with commas. |
| `GOOGLE_WEB_SEARCH_API_KEY` | Yes | Google Custom Search key |
| `GOOGLE_WEB_SEARCH_ENGINE_ID` | Yes | Custom Search CX |
| `R2_ACCOUNT_ID` | Yes | Cloudflare account ID |
| `R2_BUCKET_NAME` | Yes | Bucket name |
| `R2_ACCESS_KEY_ID` | Yes | R2 S3 access key |
| `R2_SECRET_ACCESS_KEY` | Yes | R2 S3 secret |
| `OPENAI_API_KEY` | Only if a task in `LLM_TASK_PREFERENCES` uses `openai` | |
| `OPENROUTER_API_KEY` | Only if a task uses `openrouter` | |

If any of the four `GOOGLE_*`/`R2_*` groups is missing, the run fails within seconds with `Missing required environment variable: …`.

**Shortcut with the GitHub CLI.** This copies just these keys from your local `.env`:

```bash
gh secret set -f <(grep -E '^(GEMINI_API_KEYS|OPENAI_API_KEY|OPENROUTER_API_KEY|GOOGLE_WEB_SEARCH_API_KEY|GOOGLE_WEB_SEARCH_ENGINE_ID|R2_ACCOUNT_ID|R2_BUCKET_NAME|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY)=' .env)
```

Then check that the names are there (values are never shown):

```bash
gh secret list
```

> When you rotate a key locally, update the secret too. The runner never sees your `.env`.

### 1.2 Optional repository variable

**Settings → Secrets and variables → Actions → Variables**

| Variable | Default | Effect |
| --- | --- | --- |
| `PERFORM_WEB_SEARCH` | `true` | Set to `false` to make scheduled runs fetch only `FIXED_URLS_TO_SCRAPE`. |

Manual runs have their own dropdown for this, which overrides the variable for that run.

### 1.3 Get the workflow onto `main`

GitHub only runs scheduled workflows from the **default branch**. The schedule starts once `.github/workflows/update-events.yml` is on `main`. Actions must be enabled for the repo (**Settings → Actions → General → Allow all actions**). It is on by default.

### 1.4 Guard against charges (recommended)

- **No payment method on the account:** you can never be billed. Once the monthly allowance is used up, jobs are blocked until the next month.
- **A payment method is on file:** go to **Settings (your account) → Billing and licensing → Budgets and alerts**, create an **Actions** budget of **$0** and turn on *Stop usage when budget limit is reached*.

You'll get email alerts at 90% and 100% of the included allowance either way.

---

## 2. First test run

1. Actions tab → **Update weekend happenings** → **Run workflow** (branch `main`, web search `true`).
2. ⚠️ **A test run publishes for real.** It uploads to R2 `latest/` just like a scheduled run. Run it at a time when replacing the live data is fine.
3. Expect about 2–2.5 h, the same as a local run. Most of that time is LLM calls and Gemini quota waits, not page fetching.
4. When it finishes, compare it with a recent local run:
   - The **Run pipeline** step should be green. It turns red if the pipeline throws or the R2 upload fails.
   - Download the **`run-<run id>`** artifact from the run's summary page. It contains `logs/runs/<runId>/summary.log` (stage timings, `scrapeFailures`, `uniqueEvents`) and `data/compiled/*.json`.
   - Look closely at **`scrapeFailures`** and **`uniqueEvents`**. GitHub runners use cloud datacenter IPs outside Singapore, so sites with bot protection may block more often than they do from home. If failures jump, check `error.log` for which sites failed (look for 403s, Cloudflare challenges and timeouts).

---

## 3. Everyday operation

### Where to look

- **Run history and status:** Actions tab. GitHub emails you when a scheduled run fails.
- **Detailed logs:** the run's artifact, kept for 14 days. The console log in the Actions UI only shows errors, because `NODE_ENV=production`.
- **Output:** R2 `latest/` and `archive-*`, same as before.

### Minutes budget

| | |
| --- | --- |
| Free allowance (private repo) | $12/month, about 2,000 Linux minutes |
| Runs per month at 2×/week | about 8.7, and 10 in months with five Tuesdays and five Thursdays |
| Usage at today's ~145 min per run | about 1,260–1,450 min (63–73%) |
| Break-even average per run | about 200 min in a 10-run month |
| Job hard cap | `timeout-minutes: 240` |

Manual runs use the same allowance. You can check usage at **Settings (your account) → Billing and licensing → Usage**, filtered to Actions.

If runs creep toward 200 min, it's almost always LLM quota waits. Fix the provider preferences, add Gemini keys, or lower `timeout-minutes` instead of running less often.

### Changing the schedule

The cron is **UTC**, and Singapore is UTC+8, so subtract 8 hours. If that crosses midnight, it becomes the previous day.

| Singapore time | Cron (UTC) |
| --- | --- |
| Tue & Thu 01:33 (current) | `33 17 * * 1,3` |
| Sat 06:33 | `33 22 * * 5` |
| Daily 01:33 | `33 17 * * *` (about 4,350 min/month, over the free allowance) |

Avoid minute `:00`. GitHub delays scheduled runs, and sometimes drops them, at the top of the hour.

### Pausing

Actions tab → *Update weekend happenings* → **⋯ → Disable workflow**. Enable it the same way to resume.

---

## 4. What's different from a local run

| | Local (Mac) | GitHub Actions |
| --- | --- | --- |
| Timezone | Your Mac's local time | `TZ=Asia/Singapore` set in the workflow, so "this weekend" and month names match |
| Secrets | `.env` | Repository secrets (`.env` isn't in git) |
| Chrome | Puppeteer cache in `~/.cache` | Downloaded once, then cached between runs (keyed on `package-lock.json`) |
| Machine | Your Mac | 2 vCPU / 8 GB RAM / 14 GB disk, wiped after every run |
| Outbound IP | Home/residential in Singapore | Cloud datacenter, not in Singapore |
| Logs | `logs/runs/` (last 10 kept) | Artifact for 14 days |
| Exit code | — | Non-zero if the pipeline throws or the R2 upload fails, so the run shows red |

---

## 5. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Fails in seconds with `Missing required environment variable` | A secret is missing or misspelled. Compare `gh secret list` with the table in 1.1. |
| `Could not find Chrome` / browser launch errors | Clear the cache (**Actions → Caches**, delete `puppeteer-*`) and re-run. The *Ensure Chrome is installed* step re-downloads it. |
| Many more fetch failures (`scrapeFailures`) than local | Datacenter IP blocking. Options: drop or replace the blocked sources, lean on the corsproxy fallback, or move the job to a self-hosted runner on your Mac (Settings → Actions → Runners → New self-hosted runner, then change `runs-on`). |
| Job cancelled at 4 h | `timeout-minutes` hit, usually LLM quota waits. Check `summary.log` for where the time went. |
| Scheduled run started late or didn't happen | GitHub delays scheduled runs under load. Late starts of a few minutes up to ~30 min are normal. If one is missed, trigger it manually. |
| Jobs not starting, "spending limit" message | The monthly allowance is used up. Wait for the reset or add budget. |
| Two runs overlapping | They can't. The `concurrency: update-events` group queues the second run until the first finishes. |
