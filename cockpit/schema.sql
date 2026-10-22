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
