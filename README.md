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
| Whole run capped at 10 min | `config.RUN_DEADLINE_S` |

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
