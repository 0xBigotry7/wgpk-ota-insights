"""Aggregate-only OPERA report bridge. Never reads the live guest/stay database.

Use ``--exported`` for the source report date, not today's import date. A legacy
July export imported in October remains a July snapshot. B_FORE is an OPERA
report projection, not an IDeaS demand forecast and not confirmed actuals.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path

from . import cockpit

KINDS = {"A_STAT": "actual", "B_FORE": "pms_projection", "history": "actual", "forecast": "pms_projection"}


def date_value(value: str) -> str:
    value = str(value).strip()
    for pattern in ("%Y-%m-%d", "%d-%b-%y", "%d/%m/%y"):
        try:
            return dt.datetime.strptime(value, pattern).date().isoformat()
        except ValueError:
            pass
    raise ValueError(f"invalid report date: {value[:24]}")


def number(value: object) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError("boolean is not a report number")
    try:
        result = float(str(value).replace(",", ""))
    except (ValueError, TypeError) as exc:
        raise ValueError("invalid numeric report field") from exc
    if not math.isfinite(result):
        raise ValueError("non-finite report number")
    return result


def raw_rows(text: str) -> list[dict]:
    """Parse only daily property-level rows; duplicate scopes must be resolved upstream."""
    reader = csv.DictReader(text.lstrip("\ufeff").splitlines(), delimiter="\t")
    required = {"REC_TYPE", "CONSIDERED_DATE", "CF_OCCUPANCY", "CF_AVERAGE_ROOM_RATE", "REVENUE", "NO_ROOMS", "INVENTORY_ROOMS"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("not an OPERA history_forecast daily report")
    rows = []
    for r in reader:
        kind = KINDS.get(str(r.get("REC_TYPE", "")).strip())
        if not kind:
            continue
        rows.append({"stay_date": date_value(r["CONSIDERED_DATE"]), "kind": kind,
                     "inventory": number(r["INVENTORY_ROOMS"]), "rooms_sold": number(r["NO_ROOMS"]),
                     "room_revenue": number(r["REVENUE"]), "reported_adr": number(r["CF_AVERAGE_ROOM_RATE"]),
                     "reported_occupancy": number(r["CF_OCCUPANCY"])})
    return rows


def legacy_rows(data: dict) -> list[dict]:
    rows = []
    for r in data.get("rows", []):
        if r.get("kind") not in KINDS:
            continue
        rows.append({"stay_date": date_value(r["date"]), "kind": KINDS[r["kind"]],
                     "inventory": number(r.get("inv")), "rooms_sold": number(r.get("rooms")),
                     "room_revenue": number(r.get("revenue")), "reported_adr": number(r.get("adr")),
                     "reported_occupancy": number(r.get("occ"))})
    return rows


def make_snapshot(path: Path, exported: str | None = None, currency: str | None = None) -> dict:
    source = path.read_bytes()
    text = source.decode("utf-8-sig")
    legacy = path.suffix.lower() == ".json"
    data = json.loads(text) if legacy else None
    # File mtime and current time are deliberately not fallbacks for source freshness.
    as_of = date_value(exported or (data or {}).get("exported") or "")
    if currency is not None and (len(currency) != 3 or not currency.isalpha() or currency != currency.upper()):
        raise ValueError("currency must be an explicitly verified ISO 3-letter code")
    rows = legacy_rows(data) if legacy else raw_rows(text)
    if not rows:
        raise ValueError("no usable daily aggregate rows")
    seen = set()
    for r in rows:
        key = (r["stay_date"], r["kind"])
        if key in seen:
            raise ValueError("duplicate stay date/kind: verify property-level scope")
        seen.add(key)
        if r["inventory"] is not None and r["inventory"] <= 0:
            raise ValueError("inventory must be positive, not a missing-as-zero value")
        if r["rooms_sold"] is not None and r["rooms_sold"] < 0:
            raise ValueError("negative rooms sold")
        if r["kind"] == "actual" and r["stay_date"] > as_of:
            raise ValueError("actuals cannot be after the report's as-of date")
    checksum = hashlib.sha256(source).hexdigest()
    identity = hashlib.sha256(f"{checksum}|{as_of}|{currency or ''}".encode()).hexdigest()
    return {"schema_version": 1, "snapshot": {"id": identity, "source": "opera_history_forecast",
            "source_sha256": checksum, "as_of": as_of, "currency": currency,
            "scope": "property", "precision": "legacy_rounded" if legacy else "source_report",
            "projection_semantics": "pms_report_projection_not_rms_demand_forecast"},
            "rows": sorted(rows, key=lambda r: (r["stay_date"], r["kind"]))}


def push_configured() -> dict | None:
    """Optional curated aggregate JSON on the collector host; no guest reports or date guessing.

    Disabled until a real source path is provisioned. Repeated runs with unchanged
    source bytes are idempotent at the server. Does not read or alter the PMS feed.
    """
    source = os.environ.get("WGPK_PMS_AGGREGATE_FILE")
    if not source:
        return None
    path = Path(source).expanduser()
    if path.suffix.lower() != ".json":
        raise ValueError("automatic import requires curated JSON with explicit exported date")
    return cockpit.post("/api/pms", make_snapshot(path, currency=os.environ.get("WGPK_PMS_CURRENCY")))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", type=Path)
    ap.add_argument("--exported", help="source report export date; never substitute today's upload date")
    ap.add_argument("--currency", help="verified report currency; leave unknown rather than infer THB")
    ap.add_argument("--output", type=Path, help="write aggregate payload locally; may contain hotel financials")
    ap.add_argument("--push", action="store_true", help="send aggregates to the existing authenticated cockpit")
    args = ap.parse_args()
    body = make_snapshot(args.source, args.exported, args.currency)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        args.output.write_text(json.dumps(body, ensure_ascii=False))
        args.output.chmod(0o600)
    if args.push:
        from .config import load_env
        load_env()
        result = cockpit.post("/api/pms", body)
        print(json.dumps({"ok": result.get("ok"), "source_as_of": body["snapshot"]["as_of"], "rows": len(body["rows"])}))
    else:
        print(json.dumps({"validated": True, "snapshot": body["snapshot"]["id"],
                          "source_as_of": body["snapshot"]["as_of"], "rows": len(body["rows"]),
                          "currency": body["snapshot"]["currency"], "pushed": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
