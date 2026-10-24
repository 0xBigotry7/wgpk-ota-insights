# OTA Operator Harness upgrade — 2026-10-23

## 2026-10-24 existing-report-first implementation
Gary authorizes doing feasible functions from already received OPERA reports now, deferring missing inputs to a later OPERA exploration. Reconciled the private History & Forecast original: 149 actual dates (March 1–July 27), 96 future dates (July 28–October 31), 55 columns. Implement optional numeric operating details (effective inventory/OOO, individual/group deduct vs non-deduct, arrivals/departures/no-show), preserve physical-stock calendar colors while making effective occupancy explicit. Build and backtest an independent actuals-only baseline offline, without IDeaS outputs. Do not turn a July source into a current forecast. Missing lifecycle/pace/room-type inputs are follow-up, not blockers for these functions. No OPERA login/config change or guest-sync changes.

### Existing-report release verified
- PR #28 merged `888a751`, denominator-label follow-up `205f88c`; both CI passed. 65 Python / 48 Node tests, Ruff, real-report reconciliation and local desktop/mobile interactions passed. Browser evidence under private `data/acceptance/opera-operating-*`.
- Added numeric-details table; existing Worker published as `eef22a16-7671-4207-92ab-965403e0d523`. Production manual archive poll 2026-10-24 16:19 Bangkok enriched the existing vintage (imported 0, processed 1, blocked 0), preserving original dates. Read-only API confirmed 245 operating dates, all 4 reconciliation checks true, 317 OTA metrics preserved, source 7/28 still stale.
- Original archive only read; guest routes, collector/review process, OPERA settings and OTA price/inventory untouched. UI verified locally, not through a logged-in production browser.
- Independent weekday baseline is implemented and daily-origin backtested on A_STAT only; 1/7/14/30-day occupancy MAE 13.22/14.95/16.13/16.74 pp. Poor room/revenue accuracy: NOT enabled in production calendar. Full private output `data/independent-baseline.json`; concrete feasible/delayed field map in `docs/OPERA-EXISTING-REPORT-CAPABILITIES.md`.

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

- Archive bridge implemented in cockpit Worker: R2 checksum verification, strict numeric parsing, source business-cutoff provenance, idempotent receipts, bounded retry/quarantine, concurrency lease and a separate 30-minute cron. 62 Python / 43 Node tests passed; real historical raw OPERA report parsed to 245 property-day rows. New current-report flow tested with isolated synthetic data, not claimed as a real OPERA delivery. CI/deploy/manual poll now verified below; first real scheduled/new upstream report evidence remains outstanding.

### 2026-10-24 archive bridge release verified
- PR #23 merged as bea17ab5f599e2068264b2641d3c8f260a8f587f; Cloudflare Worker 3f8089b5-4c48-404c-981c-eb7ef508784d deployed with both existing daily cron and new 07/37-minute archive cron.
- Additive target D1 tables applied. Source archive D1 is only SELECTed and R2 only GET; original email worker/routes and check-in/out untouched.
- Production manual poll 2026-10-24 11:15:52 Bangkok imported one raw historical snapshot (245 days); second poll imported zero. Source business cutoff remains 7/28, source_report precision, no blocked records; feed state waiting_for_new_report. OTA metrics preserved (317 at verification), zero live test decisions.
- 62 Python and 43 Node tests, ruff, GitHub CI and desktop/mobile local browser checks passed. New-current-report advancement tested only with isolated synthetic reports. Timer registration verified, but first real scheduled invocation/new upstream report not yet observed at delivery.
- Source blocker: no available OPERA scheduler session/credentials found in accessible browser; asked Gary for login/location, Gary said to proceed with receiving-side work. Email Routing inspection using existing OAuth returned 403; current exact analytics rule state is unverified. Do not claim upstream scheduling is the sole cause without checking it.
- Resume condition: OPERA account holder enables/checks current History & Forecast sending to the existing analytics address; then verify a real current report through archive and cockpit. See docs/OPERA-REPORT-HANDOFF.md for exact scope, evidence and fallback checks.

## 2026-10-24 Gary authorizes low-dispute foundations
After the IDeaS report, Gary asked to implement the most valuable, least controversial items while he reviews the long report. Selected A01 (explicit date/source/metric context), A03 (fixed occupancy calendar bands; no invented monetary thresholds), A09 (scoped dedupe and separate data/business/information inbox). No model rebuilding, live price/inventory writes, new feeds, schema migrations or collector changes. Other A01–A23 proposals remain unapproved. Work on feat/operator-foundations; verify locally then publish the existing cockpit through its authorized release route.

### Foundations verification
PR #24 merged (`b70afce`). All 62 Python / 46 Node tests, Ruff, and local desktop/mobile browser flows pass, including filtered alert-index mapping, occupancy vs amount legends and date contracts. Local tests never target production or call a model. Production read-only API confirms 3.1-operator-foundations, 317 OTA metrics with explicit context, 245 PMS dates, 18 scoped alerts (2 data / 16 business), and original 2026-07-28 source still stale. No migrations, collector changes or production test decisions. Final wording patch keeps absent reporting windows unknown, not point-in-time.

## 2026-10-24 multi-metric calendar and adjacent months
Gary authorized the proposed implementation: desktop cells show occupancy, ADR and RevPAR; desktop defaults to adjacent-month overview with single-month option; mobile remains single month with occupancy and ADR, RevPAR in drill-down. Keep fixed occupancy colors, missing values, original source dates and unknown currency. No new prediction, real pricing/inventory writes, schema or collector changes. In progress: frontend implementation, local responsive/interaction verification, CI and existing Worker publication.

### Calendar local acceptance complete
46 Node / 62 Python tests and Ruff passed. Extended local-only browser acceptance passed: default occupancy/ADR/RevPAR, true adjacent months, second-month selection and Copilot/date context, single/double switch, December-to-January rollover, missing next month disabled/not zero-filled, 360/390/800/1180/1399/1400/1512/1920 responsive widths, preserved what-if and investigation flows. Screenshots in ignored data/acceptance/calendar-{dual,mobile}-metrics.png inspected. Source warning remains July 28, currency unknown. Local config omits remote AI binding; no model calls.

### Calendar publication complete
PR #27 merged as cb6c205. Both GitHub CI runs passed. Existing Worker deployment uploaded the two changed assets and published version bded2d55-91e3-49b3-a25a-b55cf8f8ed4c to ota.wyndhamgardenkamala.com; existing cron schedules retained. Browser acceptance was local, not an authenticated production UI session. No schema or backend business logic changes.
Gary's follow-up correction: before any next feature, deeply understand IDeaS end-to-end business use, interaction, metric definitions and data prerequisites, then assess applicability and propose; screenshot/menu coverage is not mastery. Current approved calendar work only.

## 2026-10-24 OTA-platform-first operating workbench (active)
Gary authorizes all three OTA-native lanes: (1) discover funnels across Booking/Agoda/Expedia/Ctrip and make at-a-glance comparison; (2) lost-booking and availability investigation; (3) future channel OTB/pace performance. Start with existing true platform numbers, deepen missing analytics pages using read-only access, never treat catalogue definitions as actual data or merge incompatible windows. PMS is supporting context, not the product center. No live rate/inventory/promotion changes. Implementation branch feat/multichannel-funnel. Discovery and build continue together; capture unavailable permissions explicitly instead of fabricating a full funnel.

### OTA-native workbench release verified
- PR #29 merged as `1ec7609`; PR and main CI passed (72 Python / 53 Node tests, Ruff). Existing and new local desktop/mobile interactions pass, including source dates, native scopes, missing/rank distinction, 30/90 switching, investigation freeze and stale-PMS closure rejection.
- Added source-date provenance table (both collector SQLite and cockpit D1) without changing existing data identities. Worker version `f9a25137-a47c-4f29-8135-3dc054577d9c` published to the existing domain, retaining cron schedules.
- Hotel collector actual Git checkout is `/Users/wyndham/wgpk-ota-insights/app`, not the parent runtime-data home. Clean checkout fast-forwarded from d68339e to 1ec7609; no schedule/service restart. New read-only pages are included in the next existing daily pass.
- Bounded no-model refresh `20261024-171026` read 7 pages: 6 OK, Expedia hub still error; 26 numeric fields parsed and authenticated push confirmed. Production read-only API verified 338 metric records, complete Booking/Ctrip 30-day native funnels, Agoda ranks (not counts), five evidence investigations, future30 OTB Booking749 and Ctrip140, explicit missing Agoda/Expedia OTB.
- Booking actual selected DAYS30 and page data cutoff 10/20 were preserved; Ctrip selected range ends10/23. No claim of cross-platform comparable CTR, live data for every platform, or recovered missing Expedia permissions. OPERA source remains7/28.
- Raw evidence and production verification state stay private/ignored. UI interactions were local with real aggregate evidence, not a logged-in production-browser UI acceptance. No real OTA rate/inventory/promotion/competitor changes or review publishing.
- Final context-budget fix `f52d21a` preserves selected-date/PMS evidence and compact OTA source facts under the existing 24k prompt cap; 54 Node tests passed. Final Worker version `81ec2151-f2b0-4985-aba7-11f6112f9be6` deployed with unchanged assets and cron. No paid model call was used for acceptance.
