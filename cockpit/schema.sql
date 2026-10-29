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
CREATE TABLE IF NOT EXISTS metric_source_dates (
  day TEXT NOT NULL, platform TEXT NOT NULL, metric TEXT NOT NULL, period TEXT NOT NULL,
  run_id TEXT NOT NULL, source_as_of TEXT NOT NULL, source_date_basis TEXT NOT NULL,
  PRIMARY KEY(day,platform,metric,period,run_id)
);

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
  status TEXT NOT NULL DEFAULT 'open'  -- open | done | dropped | cleared (alert gone, closed by the dispatch)
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

-- Immutable report vintages. Never mix export time with upload time or include guest rows.
CREATE TABLE IF NOT EXISTS pms_snapshots (
  id TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  as_of TEXT NOT NULL,
  received_at TEXT NOT NULL,
  currency TEXT,
  precision TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pms_asof ON pms_snapshots (as_of DESC, received_at DESC);
CREATE TABLE IF NOT EXISTS pms_daily (
  snapshot_id TEXT NOT NULL REFERENCES pms_snapshots(id),
  stay_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('actual', 'pms_projection')),
  inventory REAL,
  rooms_sold REAL,
  room_revenue REAL,
  reported_adr REAL,
  reported_occupancy REAL,
  PRIMARY KEY(snapshot_id, stay_date, kind)
);

-- Optional allowlisted numeric operating fields; v1 core rows remain immutable/compatible.
CREATE TABLE IF NOT EXISTS pms_daily_details (
  snapshot_id TEXT NOT NULL REFERENCES pms_snapshots(id),
  stay_date TEXT NOT NULL,
  kind TEXT NOT NULL,
  details TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, stay_date, kind)
);

-- Human-approved investigation, not an OTA write. Baseline/evidence is frozen at creation.
CREATE TABLE IF NOT EXISTS operator_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  title TEXT NOT NULL,
  owner TEXT NOT NULL,
  platform TEXT NOT NULL,
  evidence TEXT NOT NULL,
  plan TEXT NOT NULL,
  baseline TEXT NOT NULL,
  review_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'investigating',
  action_at TEXT,
  outcome_note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS operator_active ON operator_decisions (source_ref) WHERE status IN ('investigating', 'reported');
CREATE TABLE IF NOT EXISTS operator_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL REFERENCES operator_decisions(id),
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  note TEXT NOT NULL
);

-- Isolated archive -> aggregate bridge; raw reports stay in their existing private R2 archive.
CREATE TABLE IF NOT EXISTS pms_snapshot_provenance (
  snapshot_id TEXT PRIMARY KEY REFERENCES pms_snapshots(id),
  as_of_basis TEXT NOT NULL,
  archived_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pms_bridge_receipts (
  file_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  bridge_version TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  snapshot_id TEXT,
  reason TEXT NOT NULL,
  PRIMARY KEY(file_id,checksum,bridge_version)
);
CREATE TABLE IF NOT EXISTS pms_feed_state (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pms_bridge_lease (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  until_ms INTEGER NOT NULL
);

-- IDeaS G3 Data Extraction (property level), one snapshot per day kept as history: the agent's "teacher".
CREATE TABLE IF NOT EXISTS ideas_snapshots (
  snapshot_date TEXT PRIMARY KEY,   -- day IDeaS generated it (ICT)
  generated_at TEXT,
  currency TEXT,
  source_sha256 TEXT NOT NULL,
  received_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  origin TEXT NOT NULL,             -- email | manual
  rows INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ideas_daily (
  snapshot_date TEXT NOT NULL,
  stay_date TEXT NOT NULL,
  capacity REAL, remaining REAL, otb REAL, otb_stly REAL, otb_group REAL, otb_transient REAL, ooo REAL, cancelled REAL,
  revenue_otb REAL, revenue_stly REAL, revenue_forecast REAL, budget_revenue REAL,
  occ_forecast REAL, budget_rooms REAL, unconstrained_demand REAL, overbooking REAL,
  revpar REAL, revpar_forecast REAL, adr REAL, adr_forecast REAL, lrv REAL, wash_pct REAL,
  bar REAL, floor REAL, ceiling REAL,
  special_event TEXT,
  competitor_median REAL,
  competitors TEXT,                 -- JSON {hotel: rate}
  PRIMARY KEY (snapshot_date, stay_date)
);
CREATE TABLE IF NOT EXISTS ideas_bridge_receipts (
  file_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  bridge_version TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  snapshot_date TEXT,
  reason TEXT NOT NULL,
  PRIMARY KEY (file_id, checksum, bridge_version)
);

-- OTA operator agent (OpenClaw on the hotel Mac mini): dashboard questions it answers, its durable notes, liveness.
CREATE TABLE IF NOT EXISTS agent_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  messages TEXT NOT NULL,           -- JSON [{role, content}] from the dashboard copilot
  stay_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | claimed | answered | expired
  claimed_at TEXT,
  answered_at TEXT,
  reply TEXT,
  actions TEXT,
  model TEXT
);
CREATE INDEX IF NOT EXISTS agent_chat_status ON agent_chat (status, created_at);
CREATE TABLE IF NOT EXISTS agent_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  topic TEXT NOT NULL,
  note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'    -- active | archived
);
CREATE TABLE IF NOT EXISTS agent_heartbeat (
  id TEXT PRIMARY KEY,
  last_seen TEXT NOT NULL,
  info TEXT NOT NULL DEFAULT ''
);
-- Data sources the agent adds itself (sources.js): pages for the Mac mini collector to probe and read daily.
CREATE TABLE IF NOT EXISTS agent_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  url TEXT NOT NULL,
  why TEXT NOT NULL,
  status TEXT NOT NULL,                    -- proposed | approved | probed | active | rejected | retired
  reason TEXT,
  catalog TEXT NOT NULL DEFAULT '[]',      -- [{key, label, unit, period, hint, peer}]
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  probed_at TEXT,
  final_url TEXT,
  title TEXT,
  sample_text TEXT,                        -- sanitized page text from the collector, no guest data
  builtin INTEGER NOT NULL DEFAULT 0,      -- 1 = a fixed collector page exposed for its text only
  slug TEXT                                -- builtin pages: the collector's page slug, e.g. booking/genius
);
CREATE INDEX IF NOT EXISTS agent_sources_status ON agent_sources (status);
CREATE TABLE IF NOT EXISTS agent_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- On-demand re-collection the agent asks for (refresh.js); the Mac mini collector serves it at its next free slot.
CREATE TABLE IF NOT EXISTS refresh_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  platforms TEXT NOT NULL,                 -- JSON list of collector platform ids
  reason TEXT NOT NULL,
  status TEXT NOT NULL,                    -- pending | running | done | failed
  picked_at TEXT,
  finished_at TEXT,
  run_id TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS refresh_requests_status ON refresh_requests (status);
