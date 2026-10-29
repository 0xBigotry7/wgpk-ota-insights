---
name: ota-cockpit
description: Read the hotel's OTA data (metrics, stay-month pace, alerts, reports, to-dos) and write to-dos, notes and dashboard chat replies through the cockpit's /api/agent API. Use for every OTA question and task.
---

# OTA cockpit API

Run `{baseDir}/ota-api` through exec. It is the only command you may run; it only talks to
`https://ota.wyndhamgardenkamala.com/api/agent/*` and adds the token itself.

    {baseDir}/ota-api GET /api/agent/brief                     # start every task here
    {baseDir}/ota-api GET /api/agent/alerts                    # also wins, pace, events, channels, revenue,
                                                               # health, report, todos, decisions, runs,
                                                               # glossary, knowledge, notes
    {baseDir}/ota-api GET '/api/agent/metrics?platform=booking&metric_prefix=pickup_90d&since=2026-10-01'
    {baseDir}/ota-api GET '/api/agent/ideas?days=60'            # IDeaS whole-hotel view per stay date (+ months);
                                                                  # read it for demand, price, forecast, whole-hotel OTB
    {baseDir}/ota-api POST /api/agent/todos '{"title":"…","detail":"…","owner":"收益/销售","platform":"booking","source":"agent"}'
    {baseDir}/ota-api POST /api/agent/todos/12 '{"status":"done"}'
    {baseDir}/ota-api POST /api/agent/notes '{"topic":"…","note":"…"}'
    {baseDir}/ota-api GET /api/agent/refresh                   # your refresh requests and the next collector slot
    {baseDir}/ota-api POST /api/agent/refresh '{"platforms":["booking"],"reason":"老姚问 11 月 Booking 在手"}'

Rules:
- Quote real numbers with their date and window; if the data is not there, say it has not been collected.
- Never suggest changing prices, availability or promotions in an OTA back office yourself: price moves are
  "收益经理在 OPERA / SynXis 调整". You cannot log in to any OTA and must not try.
- The hotel knowledge base is in `kb/` in your workspace (read only).
- Fresher numbers: the collector reads every platform at 10:20. Ask for one extra read a day with
  POST /api/agent/refresh only when a question or decision needs today's numbers and the platform's data is older
  than today (check `runs` first). Name only the platforms you need and say why. It is read at the next free slot
  (12:35, 17:05, 19:30 or 22:15 Bangkok, `next_slot` in the reply), not at once: tell the person when, answer now
  with the numbers you have and their date, and look again after the slot. A 429 means today's refresh is used.
