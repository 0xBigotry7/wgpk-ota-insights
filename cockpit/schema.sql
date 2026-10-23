-- OTA cockpit (Cloudflare D1). Holds aggregate numbers only: no guest names, no page text.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,            -- collector run id, e.g. 20261022-163347 (Bangkok time)
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,                   -- done | timeout | failed
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS page_status (
  run_id TEXT NOT NULL,
  platform TEXT NOT NULL,         -- booking | agoda | expedia | ctrip | google | tripadvisor | medallia
  page TEXT NOT NULL,             -- landing | content-score | ...
  status TEXT NOT NULL,           -- ok | signed_out | page_missing | error
  detail TEXT,
  PRIMARY KEY (run_id, platform, page)
);

-- One number read off one page on one day. (day, platform, metric, period) is the identity, so a
-- second run on the same day replaces the first instead of double counting.
CREATE TABLE IF NOT EXISTS metrics (
  day TEXT NOT NULL,              -- YYYY-MM-DD, Bangkok
  platform TEXT NOT NULL,
  metric TEXT NOT NULL,           -- stable key from ota/catalog.py, e.g. review_score
  period TEXT NOT NULL DEFAULT '',-- what the number covers, e.g. last_30_days; '' for a point-in-time value
  label TEXT NOT NULL,            -- human label, Chinese
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',  -- '', '%', 'THB', 'score/10', 'rank', ...
  benchmark REAL,                 -- the platform's own comparison value when the page shows one
  run_id TEXT NOT NULL,
  page TEXT NOT NULL,
  PRIMARY KEY (day, platform, metric, period)
);
CREATE INDEX IF NOT EXISTS metrics_platform_day ON metrics (platform, day);

CREATE TABLE IF NOT EXISTS advice (
  id TEXT PRIMARY KEY,            -- e.g. 2026-W43
  generated_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  items TEXT NOT NULL,            -- JSON [{platform, title, evidence, action, priority}]
  model TEXT NOT NULL DEFAULT ''
);

-- Operations to-dos: made from an alert, a report item, a copilot suggestion or by hand. Cockpit-only state.
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL,            -- 收益/销售 | 前台 | 客房 | 工程 | 餐饮 | 市场/内容 | 总经理
  platform TEXT NOT NULL DEFAULT 'all',
  source TEXT NOT NULL,           -- alert | report | copilot | manual
  source_ref TEXT NOT NULL DEFAULT '', -- alert id or report day#index, so the same suggestion is one to-do
  status TEXT NOT NULL DEFAULT 'open'  -- open | done | dropped
);
CREATE INDEX IF NOT EXISTS todos_status ON todos (status, updated_at);

-- What was asked of the copilot and what it said (for review; questions are typed by hotel staff).
CREATE TABLE IF NOT EXISTS copilot_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  question TEXT NOT NULL,
  reply TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS copilot_log_at ON copilot_log (at);

-- Routine checks (knowledge.js ROUTINES) ticked off per period: a day, an ISO week or a month (Bangkok).
CREATE TABLE IF NOT EXISTS routine_ticks (
  period TEXT NOT NULL,           -- 2026-10-23 | 2026-W43 | 2026-10
  item TEXT NOT NULL,             -- routine id, e.g. d-pickup
  done_at TEXT NOT NULL,
  PRIMARY KEY (period, item)
);
