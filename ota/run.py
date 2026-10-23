"""Entry point: one read-only collection, guarded so it cannot disturb the review operator.

  python -m ota.run --plan                      # print what would be read; no browser, no lock
  python -m ota.run --once [--platforms booking,agoda]

Exit codes: 0 done, 3 skipped (review operator running or a review window is near), 1 failed.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request

from . import advise, cockpit, collect, config, extract, guard, store
from .platforms import PLATFORMS


def cdp_alive(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as r:
            return "Browser" in json.load(r)
    except Exception:  # noqa: BLE001
        return False


def plan(only: set[str] | None) -> None:
    for p in PLATFORMS:
        if only and p.cid not in only:
            continue
        print(f"{p.cid}: landing {p.landing}")
        for page in p.pages:
            print(f"  {page.slug:20} {'verified  ' if page.verified else 'UNVERIFIED'} {page.url}")


def once(only: set[str] | None) -> int:
    started = collect.now()
    if not only and (prev := store.done_run_on(store.connect(config.DB), started.strftime("%Y%m%d"))):
        # launchd has a fallback slot; the first run that finishes covers the day.
        print(f"skipped: today's collection already done ({prev})", flush=True)
        return 0
    near = guard.near_review_window(started, config.AVOID_SLOTS, config.AVOID_MARGIN_MIN)
    if near:
        print(f"skipped: review window {near} is within {config.AVOID_MARGIN_MIN} min", flush=True)
        return 3
    if not cdp_alive(config.CDP_PORT):
        # The review operator starts its Chrome; we never do.
        print(f"skipped: no Chrome on CDP port {config.CDP_PORT} (review operator's browser not running)", flush=True)
        return 3
    try:
        fd = guard.take_operator_lock(config.OPERATOR_LOCK)
    except guard.Busy as e:
        print(f"skipped: {e}", flush=True)
        return 3
    run_id = started.strftime("%Y%m%d-%H%M%S")
    db = store.connect(config.DB)
    store.start_run(db, run_id, started.isoformat(timespec="seconds"))
    try:
        summary = collect.run_with_deadline(only, run_id, db)
        outcome = "done"
    except TimeoutError:
        summary, outcome = {"error": f"deadline {config.RUN_DEADLINE_S}s"}, "timeout"
    except Exception as e:  # noqa: BLE001
        summary, outcome = {"error": f"{type(e).__name__}: {e}"[:300]}, "failed"
    finally:
        guard.release(fd)
    store.finish_run(db, run_id, collect.now().isoformat(timespec="seconds"), outcome, summary)
    print(json.dumps({"run": run_id, "outcome": outcome, "summary": summary}, ensure_ascii=False), flush=True)
    # The browser and the operator's lock are released by now; the rest only reads local files.
    after(db, run_id, report=not only)       # a partial test run does not rewrite the day's report
    return 0 if outcome == "done" else 1


def after(db, run_id: str, report: bool = True) -> None:
    """Read numbers off the pages, send aggregates to the cockpit, then write the day's analysis report.

    Failures here never fail the run."""
    config.load_env()
    try:
        extract.extract_run(db, run_id)
    except Exception as e:  # noqa: BLE001
        print(f"extract failed: {type(e).__name__}: {e}", flush=True)
    try:
        print(json.dumps({"cockpit": cockpit.push_run(db, run_id)}), flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"cockpit push failed: {type(e).__name__}: {e}", flush=True)
    if not report:
        return
    try:
        body = advise.report(db, f"{run_id[:4]}-{run_id[4:6]}-{run_id[6:8]}")
        print(json.dumps({"report": body and {"id": body["id"], "items": len(body["items"])}}), flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"report failed: {type(e).__name__}: {e}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--platforms", default="")
    ap.add_argument("--after", metavar="RUN_ID", help="re-run extraction, cockpit push and the daily report for a past run")
    a = ap.parse_args()
    only = {s.strip() for s in a.platforms.split(",") if s.strip()} or None
    if a.plan:
        plan(only)
        return 0
    if a.once:
        return once(only)
    if a.after:
        after(store.connect(config.DB), a.after)
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
