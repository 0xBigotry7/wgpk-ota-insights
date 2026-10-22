"""Push one run's aggregate numbers and page health to the cockpit. Never page text or guest data."""
from __future__ import annotations

import json
import os
import sqlite3
import urllib.request

from . import config


def payload(db: sqlite3.Connection, run_id: str) -> dict:
    run = db.execute("SELECT id, started_at, finished_at, outcome FROM runs WHERE id=?", (run_id,)).fetchone()
    if not run:
        raise ValueError(f"no run {run_id}")
    pages = [{"platform": c, "page": s, "status": st, "detail": (d or "")[:300]}
             for c, s, st, d in db.execute("SELECT cid, slug, status, detail FROM snapshots WHERE run_id=?", (run_id,))]
    metrics = [{"day": day, "platform": c, "metric": m, "period": per or "", "label": lab, "value": v,
                "unit": u or "", "benchmark": b, "page": pg}
               for day, c, m, per, lab, v, u, b, pg in db.execute(
                   "SELECT day, cid, metric, period, label, value, unit, benchmark, source_slug FROM metric_values "
                   "WHERE run_id=?", (run_id,))]
    return {"run": dict(zip(("id", "started_at", "finished_at", "outcome"), run, strict=True)),
            "pages": pages, "metrics": metrics}


def post(path: str, body: dict) -> dict:
    token = os.environ.get("OTA_INGEST_TOKEN")
    if not token:
        raise RuntimeError("OTA_INGEST_TOKEN not set (put it in ~/.config/wgpk-ota-insights/env)")
    req = urllib.request.Request(config.COCKPIT_URL + path, data=json.dumps(body, ensure_ascii=False).encode(),
                                 method="POST", headers={"Authorization": f"Bearer {token}",
                                                         "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def push_run(db: sqlite3.Connection, run_id: str) -> dict:
    return post("/api/ingest", payload(db, run_id))
