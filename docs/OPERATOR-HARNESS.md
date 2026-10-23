# OTA Operator Harness — evidence-first v3

## Product boundary
An OTA operations assistant, **not** an RMS replacement. OTA dashboards supply channel performance,
content, conversion and reputation; OPERA supplies property operating context. Neither replaces the other.
No OTA write capability was added. Check-in/out and review-operator services remain separate and untouched.

Observe → normalize → diagnose → human investigation → human-reported action → comparable observation.
The model explains stored evidence and drafts work; the deterministic kernel owns freshness, evidence IDs,
state transitions, arithmetic and review gates. “Reported” is explicitly human testimony, not execution proof.
“Reviewed” is a human assessment after a comparable new sample, not a causal revenue-lift certificate.

## What was borrowed from IDeaS (public documentation, not proprietary code)

| Reference | Applied here | Deliberately not claimed |
|---|---|---|
| [Inventory concepts](https://developers.ideas.com/concepts/inbounddata/inventory/) | Source inventory per stay date, property scope, missing ≠ zero | No duplicate aggregation of group blocks + reservations; no guessing hotel capacity |
| [Data frequency](https://developers.ideas.com/developer-guide/xdata-frequency-guidelines/) | Explicit source as-of vs received time and snapshot vintages | Receipt today never refreshes an old report; no claim of live PMS integration |
| [G3 revenue meeting guide](https://help.ideasrms.com/g3rms_rp/Content/Resources/PDFGuides/G3RMSinRevenueManagementMeeting.pdf) | Date investigation, evidence context, transparent what-if, follow-up | Arithmetic sensitivity is not demand forecasting or price optimization |
| [Pricing controls](https://developers.ideas.com/concepts/decisioncontrols/1pricing/) | Distinguish realized ADR from offered rate, compare room/LOS/terms | No invented BAR from ADR or comp-set averages |
| [Last Room Value](https://developers.ideas.com/concepts/decisioncontrols/lrv/) | Explicitly mark unavailable and distinguish from selling price | No naive LRV or bid-price algorithm reconstructed |
| [Overbooking](https://developers.ideas.com/concepts/decisioncontrols/overbooking/) | Keep capacity and oversell controls out of heuristic price recommendations | No autonomous overselling or PMS inventory writes |

The authenticated G3 property was not accessible during this investigation. Screenshots and public docs
informed workflow design; this is not a claim of inspecting IDeaS internal models or this property's configuration.

## Implemented data contracts

- `ota.pms`: legacy aggregate JSON or explicitly dated OPERA `history_forecast` tabular report.
  Allowlisted numeric property-day fields only; never uploads guest rows, names, room-level records or raw pages.
- `A_STAT` → `actual`; `B_FORE` → `pms_projection`. The latter is a report future value, **not** confirmed OTB
  or unconstrained demand. Passing the stay date never silently converts it to actual.
- Source export date required. SHA256 source/vintage/currency identity makes imports immutable and idempotent.
- D1 stores immutable vintages; the UI separates `as_of`, `received_at`, data age, unknown currency and rounded legacy precision.
- Weighted ADR = Σroom revenue / Σsold room nights; occupancy = Σsold / Σavailable room nights;
  RevPAR = Σroom revenue / Σavailable room nights. Actual and future groups are never mixed. Missing components return null.
- Future report changes require the same stay date, kind, property scope, source, precision and currency in a strictly
  older source vintage; same-date reimports and actual corrections do not create pickup. These changes are not advertised
  as confirmed booking pickup until the report's business semantics are verified.
- Snapshot history reads are bounded to eight vintages; stored older versions remain retained. Comparison may be unavailable
  when no older comparable vintage is within that window. No false fallback is invented.

## Agent control plane

- Investigation cards bind immutable metric IDs, source day, period, unit and baseline; compound diagnoses carry paired evidence.
- Current data gates supersede old reports/static knowledge. ADR-vs-peer alone cannot justify a fixed price increase.
- Confirming a card only starts an investigation. Recording an action requires a human note. Both have an audit trail.
- A metric investigation cannot close as reviewed until a post-action observation exists with matching platform, metric,
  period and unit. A PMS recovery card needs a source dated within one day. Dismissal is available with a note.
- Follow-up exposes observed delta, dates and caveats. Rolling windows change composition: before/after ≠ causal effect.
- Copilot receives canonical selected-stay-date data from the server, not client-supplied financial values.
- Copilot action buttons require existing fresh evidence IDs; rate/inventory/promotion instructions cannot become model
  execution buttons. Free-text model reasoning remains a hypothesis for human review, not a mechanically verified fact.
- API writes need session + same Origin; PMS ingestion needs the separate collector token. No authentication was relaxed.

## Current source gap (verified 2026-10-23)

The legacy aggregate export contains 245 dates, exported 2026-07-28. The dedicated OPERA analytics archive's
last received batch was also July 28. The separate hourly in-house/departure email flow is working, but does not
provide room revenue or a current property-wide revenue forecast. Do not use it as a substitute.
Currency in the legacy export has not been independently verified and is left unknown.

To make current revenue/date decisions useful, the hotel must resume the **History & Forecast operating report**
with an explicit report business/export date, property scope and confirmed currency. No OPERA mail schedule,
email Worker, concierge service or guest sync was changed by this release.

## Validation and controlled improvement

`pytest` guards read-only browser contracts, source dates, scopes and numeric inputs. `npm test` tests actual SQL schema,
PMS import/auth, weighted math, vintage comparisons, evidence firewall and human review transitions.
`tools/acceptance.py` runs only against a locally seeded Worker: login, calendar, source warnings, what-if,
investigation/actions, blocked closure, desktop/mobile layout and Copilot opening. It never calls a paid model or live OTA.

For later RSI: production observations propose improvements; fixed synthetic safety cases plus held-out hotel cases
validate candidates separately. Never let the model edit gates, grade its own task completion, or promote a rule
from one correlated outcome. Full demand forecasting, channel commission economics, verified per-stay-date OTA
inventory and causal experiments remain separate work—not fabricated features of this release.
