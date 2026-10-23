# wgpk-ota-insights — read-only OTA metrics for Wyndham Garden Phuket Kamala

Once a day this reads the hotel's OTA dashboards (Booking.com, Agoda, Expedia, Ctrip eBooking,
Google Business, TripAdvisor, Medallia), keeps the pages on the hotel Mac, turns
them into numbers and writes a detailed Chinese OTA analysis and advice report every day. Numbers and
reports are shown in the OTA cockpit (`cockpit/`, https://ota.wyndhamgardenkamala.com).

It is **completely separate from review replies** (`wgpk-reviews` / `operator_v2`): different repo,
different launchd job, no shared code, no writes to the Review Desk.

## What it can and cannot do

- It opens pages by URL and reads them: page text, the page's link list, a screenshot.
- It cannot click, type, fill, sign in, submit, or launch/quit Chrome. Collectors only ever see
  `ota/readonly.py:ReadOnlyTab`, and `tests/test_readonly.py` fails if any module gains such a call.
- A signed-out or challenge page is recorded as `signed_out` and that platform is skipped. Sign-in
  recovery stays with the review operator.

## Isolation from the review operator

The review operator keeps every OTA signed in inside one headed Chrome (CDP `127.0.0.1:9333`). We
reuse that browser rather than opening a second one, because a second sign-in per OTA would mean
new 2FA prompts and new risk-control signals on the same accounts the reviews depend on.

| Guard | Where |
|---|---|
| Never starts within 60 min of a review window (`WGPK_OTA_AVOID`, default `09:15,14:45`) | `guard.near_review_window` |
| Skips when the review operator holds `operator.lock`; holds that lock for the whole collection so a review run cannot start on the same Chrome mid-collection | `guard.take_operator_lock` |
| Skips when the operator's Chrome is not running (never launches it) | `run.cdp_alive` |
| Opens its own tabs and closes them in `finally`; never touches the operator's tabs | `collect.collect_platform` |
| Whole run capped at 15 min | `config.RUN_DEADLINE_S` |

Trade-off: a reply Gary approves during those minutes waits for the next review run. If the review
schedule is changed on the Review Desk, update `WGPK_OTA_AVOID` in the plist to match.

## Run

    python -m ota.run --plan                       # pages per platform, no browser
    python -m ota.run --once --platforms booking   # one platform
    python -m ota.run --once                       # what launchd runs at 10:20 (fallback 11:30)

Exit 0 = done, 3 = skipped by a guard, 1 = failed. Output lives in `$WGPK_OTA_HOME/data/`
(0700): `snapshots/<run>/<platform>/<page>.{txt,png,links.json}` and `ota.sqlite`
(`runs`, `snapshots`, `metrics`). Snapshots can contain guest names (e.g. an inbox preview); they
never leave the machine and are not committed.

## Install on the Wyndham Mac mini (manual, not auto-pulled)

    mkdir -p ~/wgpk-ota-insights/logs && cd ~/wgpk-ota-insights
    git clone <repo> app && cd app && uv venv ../.venv && uv pip install -p ../.venv -e .
    ../.venv/bin/python -m ota.run --once --platforms google     # first manual check
    cp launchd/com.wgpk.ota-insights.plist ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wgpk.ota-insights.plist

Uninstall: `launchctl bootout gui/$(id -u)/com.wgpk.ota-insights`. Nothing in the review operator
needs to change either way.

## Calibration (phase 2)

Pages marked `# UNVERIFIED` in `ota/platforms.py` are guesses (first calibration: 2026-10-22, run 20261022-163347). After the first manual run, read each
platform's `landing.links.json` for the real analytics/score/inbox URLs and replace the guesses.
A wrong guess only produces a `page_missing` or `error` snapshot.

## Next phases

3. Daily schedule, watched for a week against the Review Desk run proof.
4. Daily report: after each run `ota.advise` writes the day's analysis (highlights, 5–10
   recommendations with evidence, analysis, owner and expected effect, things to watch tomorrow)
   from the stored numbers and posts it to the cockpit. Every item must cite a stored number.
5. Cockpit v2: proactive alerts (`cockpit/src/monitor.js`: below the comp set or brand average, worse than
   last week, back office signed out, no run for 30 h, Ctrip Q&A waiting) with the team that acts and a first
   step; to-dos made from alerts, report items or the copilot; a right-hand copilot that answers from the
   stored numbers and proposes to-dos (`cockpit/src/copilot.js`). The copilot cannot reach any OTA back
   office. Optional daily Telegram digest at 12:30 Bangkok.

### Cockpit setup after v2

```bash
cd cockpit
npx wrangler d1 execute wgpk_ota --remote --file schema.sql   # adds todos and copilot_log (IF NOT EXISTS)
npx wrangler deploy
# Copilot model: Workers AI by default (binding AI). For DeepSeek / OpenAI instead:
#   npx wrangler secret put COPILOT_API_KEY      (+ COPILOT_BASE_URL e.g. https://api.deepseek.com, COPILOT_MODEL e.g. deepseek-chat)
# Daily push (off until set): npx wrangler secret put TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
```

## Evidence-first operator workspace (v3)

The existing cockpit now includes an OPERA property-day calendar, source-vintage warnings, weighted revenue KPIs,
manual arithmetic what-if, evidence-bound investigation cards and human action/review records. The Copilot sees
selected-date data and source gaps. It still cannot write to an OTA, PMS or the review operator.
See [design, IDeaS references and limits](docs/OPERATOR-HARNESS.md).

### Aggregate PMS bridge

```sh
# Legacy parsed operating export. Source date comes from its `exported` field, never file mtime.
python -m ota.pms /private/path/opera_daily.json --output /private/path/payload.json
# Raw property-day History & Forecast TSV needs the actual report export date.
python -m ota.pms /private/path/history_forecast.txt --exported YYYY-MM-DD --push
# Add --currency THB ONLY after checking the report's currency. Unknown is allowed.
```

`--push` loads the same collector token as OTA ingest. Payloads contain financial aggregates, so keep them
outside Git. Upload is idempotent. An old export remains stale even when uploaded today.

Optional collector hook: set `WGPK_PMS_AGGREGATE_FILE` in the existing collector env to a **curated JSON** with
an explicit `exported` source date (and optionally `WGPK_PMS_CURRENCY` once verified). After each scheduled OTA
run it imports that file; missing configuration means disabled, and failure does not break OTA collection.
It neither downloads guest reports nor changes the in-house/departure pipeline. Provision a genuinely updating
source before enabling—reusing a fixed July file will not create current data.

Apply additive D1 schema before deploying code (`cockpit/schema.sql`, all new tables are IF NOT EXISTS).
Python collector releases are still manual; Cloudflare deploys on tested main pushes. Local UI acceptance uses
Chrome + Playwright and a seeded local Worker; run `.venv/bin/python tools/acceptance.py`, never point it at production.
