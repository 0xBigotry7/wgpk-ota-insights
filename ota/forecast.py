"""Independent, offline OPERA actuals-only forecasting baseline and rolling backtest.

No IDeaS output, PMS B_FORE room/revenue values, booking pickup, or guest data.
Uses last 56 days' same-weekday physical-stock occupancy and RevPAR. This is a
seasonality-naive benchmark, not the final demand/pricing model or a live feed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

from .pms import raw_rows

VERSION = "opera-actual-weekday-v1"


def baseline(rows: list[dict], as_of: str, stay_date: str, method: str = "weekday") -> dict | None:
    cutoff, target = dt.date.fromisoformat(as_of), dt.date.fromisoformat(stay_date)
    if target < cutoff or method not in {"weekday", "pooled"}:
        raise ValueError("invalid forecast target or method")
    history = sorted((r for r in rows if r["kind"] == "actual"
                      and 0 < (cutoff - dt.date.fromisoformat(r["stay_date"])).days <= 56
                      and all(isinstance(r.get(k), (int, float)) and not isinstance(r[k], bool)
                              for k in ("inventory", "rooms_sold", "room_revenue"))
                      and r["inventory"] > 0 and 0 <= r["rooms_sold"] <= r["inventory"]
                      and r["room_revenue"] >= 0), key=lambda r: r["stay_date"])
    if len({r["stay_date"] for r in history}) != len(history):
        raise ValueError("duplicate actual dates require scope reconciliation")
    if len(history) < 28:
        return None
    sample = [r for r in history if dt.date.fromisoformat(r["stay_date"]).weekday() == target.weekday()] if method == "weekday" else history
    if len(sample) < 4:
        return None
    capacity = history[-1]["inventory"]  # Explicit proxy, never future actual capacity.
    stock = sum(r["inventory"] for r in sample)
    occ = sum(r["rooms_sold"] for r in sample) / stock
    revpar = sum(r["room_revenue"] for r in sample) / stock
    rooms, revenue = capacity * occ, capacity * revpar
    return {"model": VERSION, "method": method, "as_of": as_of, "stay_date": stay_date,
            "training_start": history[0]["stay_date"], "training_end": history[-1]["stay_date"],
            "sample_days": len(sample), "inventory": capacity, "capacity_basis": "last_actual_proxy",
            "rooms_sold": rooms, "room_revenue": revenue, "occupancy": occ * 100,
            "adr": revenue / rooms if rooms > 0 else None, "revpar": revpar,
            "limitations": "无预订进度/取消/节假日/旺淡季模型；总库存沿用末实绩；非实时需求或价格建议"}


def backtest(rows: list[dict]) -> dict:
    actual = sorted([r for r in rows if r["kind"] == "actual"], key=lambda r: r["stay_date"])
    dates = [dt.date.fromisoformat(r["stay_date"]) for r in actual]
    by_date = {r["stay_date"]: r for r in actual}
    if len(by_date) != len(actual):
        raise ValueError("duplicate actual dates")
    result = {"model": VERSION, "truth": "OPERA A_STAT only", "origin_stride_days": 1,
              "horizon_definition": "D+h target, training dates strictly before D", "scores": []}
    if not dates:
        return result
    for horizon in (1, 7, 14, 30):
        for method in ("weekday", "pooled"):
            pairs = []
            origin = dates[0] + dt.timedelta(days=56)
            while origin + dt.timedelta(days=horizon) <= dates[-1]:
                target = (origin + dt.timedelta(days=horizon)).isoformat()
                truth = by_date.get(target)
                pred = baseline(actual, origin.isoformat(), target, method)
                if pred and truth and truth["inventory"] and all(truth[k] is not None for k in ("rooms_sold", "room_revenue")):
                    pairs.append((pred, truth))
                origin += dt.timedelta(days=1)
            if not pairs:
                continue
            count = len(pairs)
            occ_mae = sum(abs(p["occupancy"] - t["rooms_sold"] / t["inventory"] * 100) for p, t in pairs) / count
            metric = {"horizon_days": horizon, "method": method, "n": count, "occupancy_mae_pp": occ_mae}
            for k in ("rooms_sold", "room_revenue"):
                denom = sum(abs(t[k]) for _, t in pairs)
                metric[k + "_wape_pct"] = sum(abs(p[k] - t[k]) for p, t in pairs) / denom * 100 if denom else None
                metric[k + "_bias"] = sum(p[k] - t[k] for p, t in pairs) / count
            result["scores"].append(metric)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--as-of", required=True, help="original source business date, never import date")
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--output", type=Path, required=True, help="private local result; not a production upload")
    args = parser.parse_args()
    if not 1 <= args.days <= 90:
        parser.error("days must be 1–90; longer horizons need seasonality validation")
    rows = raw_rows(args.report.read_text(encoding="utf-8-sig"))
    origin = dt.date.fromisoformat(args.as_of)
    # All rows used in evaluation must be genuine history strictly before this vintage.
    rows = [r for r in rows if r["kind"] == "actual" and r["stay_date"] < args.as_of]
    predictions = [baseline(rows, args.as_of, (origin + dt.timedelta(days=d)).isoformat()) for d in range(args.days)]
    out = {"source_as_of": args.as_of, "production": False, "backtest": backtest(rows),
           "forecasts": [p for p in predictions if p],
           "limits": "历史报表离线研究；短期滚动回测不是当前旺季精度证明；不自动发布至线上日历"}
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.output.write_text(json.dumps(out, ensure_ascii=False, indent=2))
    args.output.chmod(0o600)
    print(json.dumps({"source_as_of": args.as_of, "actual_days": len(rows), "forecast_days": len(out["forecasts"]),
                      "production": False, "backtest_scores": out["backtest"]["scores"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
