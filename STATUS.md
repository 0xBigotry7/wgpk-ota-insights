# OTA Operator Harness upgrade — 2026-10-23

## Authorized objective
Improve the existing wgpk-ota-insights product using the legacy OPERA analytics cockpit and publicly documented IDeaS workflows. Reuse aggregate PMS exports; preserve the repository's strictly read-only OTA collector and review-operator isolation. No live OTA pricing/inventory writes or authenticated IDeaS changes.

## Baseline
- Repository: 0xBigotry7/wgpk-ota-insights, baseline 19f3c29, branch feat/ideas-inspired-operator-harness.
- Existing product: read-only OTA collectors on Wyndham host; Cloudflare Worker/D1 cockpit, alerts, routines, report, Copilot and human to-dos.
- Legacy aggregate analytics: wgpk host ~/opera_data/opera_daily.json, exported 2026-07-28, latest actual 2026-07-27. Do not pretend this archive is current.
- PMS in-house/departure pipeline stays untouched.

## Delivery scope
1. Source-dated aggregate PMS import, validation, versioned snapshots and explicit freshness.
2. IDeaS-inspired actual/projection calendar, date drill-down, correctly weighted KPIs, same-date pickup only with comparable snapshots, transparent arithmetic what-if (not predictive claims).
3. Evidence-bound operating recommendations, hypotheses versus facts, data gates and human action/outcome review; never declare a task done or a revenue lift from model prose.
4. Integrate report and Copilot context and preserve existing read-only/authentication controls.
5. Isolated tests, browser acceptance, source research notes, reviewable Git change and verified deployment if permitted by existing release workflow.

## Release verified
- PR #22 merged as `d68339e2d1a5fc82beda4e28f4e2bcfef30c0e4c`.
- 62 Python tests, 35 Node tests, ruff and local desktop/mobile browser flows passed; GitHub CI also passed.
- GitHub deploy workflow 39986069322 reported success but skipped schema/deploy due to missing repository deployment secrets.
  Do not treat that job conclusion as deployment proof. Used existing local Wrangler OAuth instead.
- Additive D1 schema applied; Worker deployed at `ota.wyndhamgardenkamala.com`.
  Cloudflare version: `8b63a81a-9ca3-458a-90dc-1621d7dfa6ff`.
- Hotel collector fast-forwarded to d68339e, compiled successfully. No browser collection, review changes,
  guest sync changes, service restart or OPERA email schedule change was triggered.
- Production aggregate API verified: `3.0-evidence-operator`, 226 OTA metrics, 245 PMS dates,
  OPERA source 2026-07-28 explicitly stale, currency unknown, 7 investigation cards, no test decisions.
- Legacy aggregates remain outside Git; imported once from the collector using its existing private ingest token.

## Remaining dependency / next gate
The dedicated analytics archive last received July 28. Current History & Forecast operating reports must resume
with verified export/business date, property scope and currency before live revenue/date decisions are meaningful.
The optional curated-file sync hook is implemented but intentionally unconfigured without a genuinely updating source.
True booking pickup, demand forecasting, net channel profitability and causal uplift are not claimed.

## Rollback
The new schema is additive. Previous Worker deployment metadata is saved outside Git in data/worker-deployments-before.json.
Rollback the Worker to the previous Cloudflare version if required; do not delete source/audit tables or guest-sync state.
Collector code can be restored independently; no launchd or browser configuration changed.

## 2026-10-24 continuous-feed task
Gary requested connecting continuous OPERA reports. Confirmed analytics archive still only contains July 28 History & Forecast; no existing OPERA hotel-browser session found. Requested login/credential location while implementing independent archive-to-cockpit transfer. Do not alter the working in-house/departure routes.

- Archive bridge implemented in cockpit Worker: R2 checksum verification, strict numeric parsing, source business-cutoff provenance, idempotent receipts, bounded retry/quarantine, concurrency lease and a separate 30-minute cron. 62 Python / 43 Node tests passed; real historical raw OPERA report parsed to 245 property-day rows. New current-report flow tested with isolated synthetic data, not claimed as a real OPERA delivery. Pending CI/deploy/manual poll and scheduled-run evidence.
