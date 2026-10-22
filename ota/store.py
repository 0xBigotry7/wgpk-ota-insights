"""Local SQLite record of runs and page snapshots. Raw page text stays on disk next to it (0700)."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT, note TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  run_id TEXT NOT NULL REFERENCES runs(id), cid TEXT NOT NULL, slug TEXT NOT NULL,
  captured_at TEXT NOT NULL, status TEXT NOT NULL,          -- ok | signed_out | page_missing | error
  url TEXT, http_status INTEGER, title TEXT, detail TEXT, text_path TEXT, shot_path TEXT, links_path TEXT,
  PRIMARY KEY (run_id, cid, slug)
);
-- Filled by the extraction step (next phase); one row per number read off a snapshot.
CREATE TABLE IF NOT EXISTS metrics (
  run_id TEXT NOT NULL, cid TEXT NOT NULL, metric TEXT NOT NULL, value REAL, unit TEXT, period TEXT,
  source_slug TEXT NOT NULL, extracted_by TEXT NOT NULL,
  PRIMARY KEY (run_id, cid, metric, period)
);
"""


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    return db


def start_run(db: sqlite3.Connection, run_id: str, started_at: str) -> None:
    db.execute("INSERT INTO runs (id, started_at) VALUES (?, ?)", (run_id, started_at))
    db.commit()


def finish_run(db: sqlite3.Connection, run_id: str, finished_at: str, outcome: str, note: dict) -> None:
    db.execute("UPDATE runs SET finished_at=?, outcome=?, note=? WHERE id=?",
               (finished_at, outcome, json.dumps(note, ensure_ascii=False), run_id))
    db.commit()


def add_snapshot(db: sqlite3.Connection, **row: object) -> None:
    cols = ", ".join(row)
    db.execute(f"INSERT OR REPLACE INTO snapshots ({cols}) VALUES ({', '.join('?' * len(row))})",
               tuple(row.values()))
    db.commit()
