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

## State
Implemented aggregate PMS import, versioned calendar/weighted metrics, What-if, deterministic evidence cards,
human investigation/action/review states, Copilot date context and action firewall. Static price heuristics corrected.
Local validation: 62 Python tests, 35 Node tests, ruff and desktop/mobile browser flows passing.
Confirmed analytics archive last received July 28; fresh operating-report feed remains an external dependency.
Next: final regression, Git/CI, deploy additive D1 schema + cockpit, import historical aggregates with stale label,
verify live aggregate API and release collector code without running its browser or touching guest sync.
