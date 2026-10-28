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
    {baseDir}/ota-api POST /api/agent/todos '{"title":"…","detail":"…","owner":"收益/销售","platform":"booking","source":"agent"}'
    {baseDir}/ota-api POST /api/agent/todos/12 '{"status":"done"}'
    {baseDir}/ota-api POST /api/agent/notes '{"topic":"…","note":"…"}'

Rules:
- Quote real numbers with their date and window; if the data is not there, say it has not been collected.
- Never suggest changing prices, availability or promotions in an OTA back office yourself: price moves are
  "收益经理在 OPERA / SynXis 调整". You cannot log in to any OTA and must not try.
- The hotel knowledge base is in `kb/` in your workspace (read only).
