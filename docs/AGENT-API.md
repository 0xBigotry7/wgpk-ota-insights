# OTA operator agent: cockpit API

The agent (OpenClaw agent `ota` on the hotel Mac mini, model openai/gpt-6.1-sol, thinking medium) is the product.
The cockpit Worker is its tool backend and the dashboard shows the same data. Base URL
`https://ota.wyndhamgardenkamala.com`. Every call needs `Authorization: Bearer $AGENT_TOKEN`
(Worker secret `AGENT_TOKEN`, separate from the ingest token and the dashboard password).

The agent never writes to an OTA back office, never touches the review operator (Chrome/CDP, `operator.lock`,
its files), and never changes prices, availability or promotions. Writes are limited to the rows below.

## Read tools (GET)

| Path | Returns |
|---|---|
| `/api/agent/brief` | `{text}`: the full data block (agent notes, data reliability, stay-month pace, holidays, every metric with its window and benchmark, alerts, report, to-dos). Start every task here. `?format=json` for the structured version |
| `/api/agent/alerts` | serious/warning alerts with `why`, `steps`, `kpi`, `owner` |
| `/api/agent/wins` | what is going well |
| `/api/agent/pace` | per stay month: booked within 30/90 days and ADR vs peers; on-the-books vs last year and pickup when available |
| `/api/agent/events` | source-market holidays with `live_by` / `setup_by` campaign dates |
| `/api/agent/channels` | per-platform funnels, losses, future on-the-books |
| `/api/agent/revenue` | OPERA calendar status and months (source date in `source.as_of`) |
| `/api/agent/health` | per platform and day: whether the collector read it |
| `/api/agent/report` | latest daily analysis report |
| `/api/agent/todos`, `/api/agent/decisions` | to-dos and investigations (baseline, review date, follow-up) |
| `/api/agent/runs` | latest collection runs and page status |
| `/api/agent/glossary` | metric definitions |
| `/api/agent/knowledge` | the OTA playbook (ranking factors, programme thresholds, symptom → cause → action) and the daily/weekly/monthly routines |
| `/api/agent/metrics?platform=&metric=&metric_prefix=&period=&since=&until=&limit=` | raw daily metric rows, newest first, max 500 |
| `/api/agent/notes` | the agent's own active notes (`?all=1` includes archived) |

## Writes (POST, JSON)

| Path | Body | Effect |
|---|---|---|
| `/api/agent/todos` | `{title, detail?, owner, platform, source: "agent", source_ref?}` | new to-do on the dashboard board. `owner` is one of 收益/销售, 前台, 客房, 工程, 餐饮, 市场/内容, 总经理 |
| `/api/agent/todos/:id` | `{status: open\|done\|dropped\|cancelled, reason}` | update a to-do; `cancelled` (superseded or withdrawn) needs a `reason`, appended to the detail |
| `/api/agent/notes` | `{topic, note}` | durable memory: what worked, hotel facts, decisions. Shown on the dashboard |
| `/api/agent/notes/:id` | `{status: active\|archived}` | retire a note |
| `/api/agent/heartbeat` | `{info?}` | liveness; `chat/next` also counts |

## IDeaS (cockpit/src/ideas.js)

- `GET /api/agent/ideas?days=60&from=YYYY-MM-DD` (AGENT_TOKEN): latest IDeaS G3 Data Extraction snapshot per stay date (otb, otb_stly,
  otb_group, otb_transient, ooo,
  occ_forecast, unconstrained_demand, budget_rooms, bar, floor, ceiling, lrv, competitor_median, competitors, adr/revenue on books and
  forecast, cancelled, wash_pct, special_event), `change` vs the previous snapshot, `booking` = our Booking pace for the same stay
  date / month, and `months` rolled up.
- `POST /api/ingest/ideas` (OTA_INGEST_TOKEN): one export as the raw .xlsx body (manual import).
- Cron `7,37 * * * *` imports .xlsx sent to ideas-reports@ from the archive (docs/IDEAS-REPORT-HANDOFF.md). One snapshot per
  generation day is kept as history (`ideas_snapshots`, `ideas_daily`).

## Data sources the agent adds (cockpit/src/sources.js, skill agent/skills/ota-sources)

Agent (AGENT_TOKEN):
- `GET /api/agent/sources`: mode, limits, all sources (proposed | approved | probed | active | rejected | retired; `builtin` = a fixed collector page shared for its text).
- `POST /api/agent/sources {platform, url, why}`: Booking/Agoda/Ctrip/Expedia back-office hosts only (no Medallia); action,
  guest-message, review and order pages refused (English and Chinese words, path, query and #hash); 3 a day. Mode auto → `approved`, approve → `proposed`.
- `GET /api/agent/sources/:id/sample`: sanitized page text from the probe.
- `POST /api/agent/sources/:id/catalog {metrics:[{key, label, unit, period, hint, peer}]}`: needs a probed page; ≤10 active; sets `active`.
- `POST /api/agent/sources/:id/status {status:"retired", reason}`; `POST /api/agent/sources/mode {mode:"approve"}` (tighten only).

Collector (OTA_INGEST_TOKEN):
- `GET /api/ingest/sources`: approved (to probe) and active (to read daily, with catalog); URLs re-validated.
- `POST /api/ingest/sources/:id/probe {ok, final_url, title, sample_text ≤20 KB sanitized, reason}` → probed | rejected (an active source stays active).
- `POST /api/ingest/sources/builtin {pages:[{slug:"booking/genius", url, title, sample_text}]}`: text of fixed analysis pages.
- `POST /api/ingest/sources/:id/approve`, `POST /api/ingest/sources/mode {mode: auto|approve}`: Gary's side.
- Extracted numbers come in through the normal `/api/ingest` with the catalog keys.

## Fresher numbers on demand (cockpit/src/refresh.js, ota/refresh.py)

The collector reads every platform once a day at 10:20. When a question or decision needs today's numbers and a
platform's data is older, the agent may ask for one extra read a day (Gary 2026-10-29: OTA work is not hour-by-hour):

- `POST /api/agent/refresh {platforms: ["booking", …], reason}`: platforms from booking, agoda, expedia, ctrip,
  google, tripadvisor, medallia; reason required. While a request is pending another ask merges into it. A second
  request the same Bangkok day is 429. The reply carries `next_slot`.
- `GET /api/agent/refresh`: the last 10 requests (pending → running → done | failed) with run id and detail.
- Collector (ingest token): `GET /api/ingest/refresh/next` claims the waiting request; `POST /api/ingest/refresh/:id
  {status: done|skipped|failed, run_id, detail}`. Skipped puts it back in the queue; a claim untouched for 30 min
  returns to pending.
- The collector serves it only after the day's full run is done, at its existing slots (12:35, 17:05, 19:30, 22:15),
  with the usual guards: review windows, the operator's lock and Chrome, read-only pages. A full run that finishes
  while a request waits marks it done ("covered by the daily full collection").

## Dashboard chat (the copilot panel talks to the agent)

1. When the agent has been seen in the last 180 s, a question typed in the dashboard is queued instead of
   going to the API model.
2. The agent polls `GET /api/agent/chat/next` (every 5–10 s). It returns `{request: null}` or
   `{request: {id, messages: [{role, content}], stay_date, answer_within_s: 75, reply_to}}`. A request is handed out once.
   A claim with no answer for 5 min goes back to the queue.
3. The agent answers with `POST /api/agent/chat/:id {reply, actions?, model?}`. `reply` is Chinese text, with `-` lists
   and `**bold**` allowed. `actions`, at most 4, are `{type: "todo", title, owner, platform, detail, evidence_ids}`. They
   become "加入待办" buttons only when every evidence id is current; price, promotion and inventory actions never do
   (same guard as before).
4. When there is no answer within 75 s, the dashboard's own API model answers and a late agent reply gets 409.

## Setup

- `npx wrangler d1 execute wgpk_ota --remote --file cockpit/schema.sql` adds `agent_chat`, `agent_notes`
  and `agent_heartbeat` (IF NOT EXISTS).
- `npx wrangler secret put AGENT_TOKEN`. Store the same value only in the agent's environment on the Mac mini.
