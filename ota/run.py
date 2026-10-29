"""Entry point: one read-only collection, guarded so it cannot disturb the review operator.

  python -m ota.run --plan                      # print what would be read; no browser, no lock
  python -m ota.run --once [--platforms booking,agoda]

Exit codes: 0 done, 3 skipped (review operator running or a review window is near), 1 failed.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import urllib.request
from pathlib import Path

from . import advise, cockpit, collect, config, extract, guard, refresh, sources, store
from .platforms import PLATFORMS, Page

PUSH_RETRY_S = 10
# Platforms worth a second pass later the same day when the morning run found them signed out.
RETRY_LATER = {"medallia"}


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
    second_pass = False
    if not only and (prev := store.done_run_on(store.connect(config.DB), started.strftime("%Y%m%d"))):
        # launchd has a fallback slot; the first run that finishes covers the day. The one exception: platforms
        # that were signed out in the morning (Medallia's Okta challenge clears only at the operator's 11:30
        # run) get a second, platform-only pass.
        retry = store.signed_out_today(store.connect(config.DB), started.strftime("%Y%m%d"), RETRY_LATER)
        if not retry:
            print(f"skipped: today's collection already done ({prev})", flush=True)
            config.load_env()
            if req := refresh.claim():
                rc = serve_refresh(req)
                probe_sources()          # checks the review window and the lock again
                return rc
            return probe_sources()
        print(f"today's collection done ({prev}); second pass for signed-out {sorted(retry)}", flush=True)
        only, second_pass = retry, True
    near = guard.near_review_window(started, config.AVOID_SLOTS, config.AVOID_MARGIN_MIN)
    if near:
        return skipped(started, f"review window {near} is within {config.AVOID_MARGIN_MIN} min")
    if not cdp_alive(config.CDP_PORT):
        # The review operator starts its Chrome; we never do.
        return skipped(started, f"no Chrome on CDP port {config.CDP_PORT} (review operator's browser not running)")
    try:
        fd = guard.take_operator_lock(config.OPERATOR_LOCK)
    except guard.Busy as e:
        return skipped(started, str(e))
    run_id = started.strftime("%Y%m%d-%H%M%S")
    db = store.connect(config.DB)
    store.start_run(db, run_id, started.isoformat(timespec="seconds"))
    extra = {} if only else agent_pages()
    try:
        summary = collect.run_with_deadline(only, run_id, db, extra)
        outcome = "done"
    except TimeoutError:
        summary, outcome = {"error": f"deadline {config.RUN_DEADLINE_S}s"}, "timeout"
    except Exception as e:  # noqa: BLE001
        summary, outcome = {"error": f"{type(e).__name__}: {e}"[:300]}, "failed"
    finally:
        guard.release(fd)
    if outcome != "done":
        not_reached(db, run_id, only, outcome)
    store.finish_run(db, run_id, collect.now().isoformat(timespec="seconds"), outcome, summary)
    print(json.dumps({"run": run_id, "outcome": outcome, "summary": summary}, ensure_ascii=False), flush=True)
    if not only and outcome == "done":
        # The full read covers whatever the agent asked for since; it need not spend its one refresh a day.
        config.load_env()
        if req := refresh.claim():
            refresh.report(req["id"], "done", run_id, "covered by the daily full collection")
    # The browser and the operator's lock are released by now; the rest only reads local files.
    # A partial test run does not rewrite the day's report; a second pass that fills in a signed-out platform does.
    after(db, run_id, report=not only or second_pass)
    return 0 if outcome == "done" else 1


def serve_refresh(req: dict) -> int:
    """Read only the platforms the agent asked for, under the same guards; report the outcome to the cockpit.

    A guard skip (review window, operator busy, no Chrome) puts the request back for the next slot."""
    db = store.connect(config.DB)
    before = {r for (r,) in db.execute("SELECT id FROM runs")}
    print(f"agent refresh {req['id']}: {sorted(req['platforms'])} ({req['reason'][:80]})", flush=True)
    code = once(set(req["platforms"]))
    new = sorted({r for (r,) in db.execute("SELECT id FROM runs")} - before)
    run_id = new[-1] if new else ""
    note = db.execute("SELECT note FROM runs WHERE id=?", (run_id,)).fetchone() if run_id else None
    status = {0: "done", 3: "skipped"}.get(code, "failed")
    refresh.report(req["id"], status, run_id, (note[0] if note and note[0] else "")[:500])
    return code


def agent_pages() -> dict[str, list]:
    """Active agent-added sources as extra pages for today's full run; the cockpit being down never stops a run."""
    config.load_env()
    try:
        found = sources.fetch()
    except Exception as e:  # noqa: BLE001
        print(f"agent sources unavailable: {type(e).__name__}", flush=True)
        found = []
    sources.save_active(found)
    extra: dict[str, list] = {}
    for s in sources.active(found):
        extra.setdefault(s["platform"], []).append(Page(sources.slug(s), sources.template(s["url"]), settle_ms=4000))
    return extra


def probe_sources() -> int:
    """Read newly approved agent sources once, in a free window, holding the operator's lock; at most
    sources.MAX_PROBES_PER_DAY a day. Results (sanitized text or the reason) go back to the cockpit."""
    started = collect.now()
    config.load_env()
    try:
        todo = sources.probe_candidates(sources.fetch())
    except Exception as e:  # noqa: BLE001
        print(f"agent sources unavailable: {type(e).__name__}", flush=True)
        return 0
    db = store.connect(config.DB)
    at = started.isoformat(timespec="seconds")
    for s in [s for s in todo if sources.fixed_page(s["platform"], s["url"])]:
        # A page the collector already reads every day: answer without spending a probe or the browser.
        todo.remove(s)
        fixed = sources.fixed_page(s["platform"], s["url"])
        try:
            sources.post_probe(s["id"], False, reason=f"already read daily as {fixed}; its numbers are in "
                               f"GET /api/agent/metrics?platform={s['platform']}")
            sources.record_probe(db, at, s["id"], "duplicate")
        except Exception as e:  # noqa: BLE001
            print(f"probe report failed for {s['id']}: {type(e).__name__}", flush=True)
    left = sources.MAX_PROBES_PER_DAY - sources.probes_today(db, started.date().isoformat())
    if not todo or left <= 0:
        return 0
    if near := guard.near_review_window(started, config.AVOID_SLOTS, config.AVOID_MARGIN_MIN):
        print(f"probe skipped: review window {near} is near", flush=True)
        return 3
    if not cdp_alive(config.CDP_PORT):
        print("probe skipped: no operator Chrome", flush=True)
        return 3
    try:
        fd = guard.take_operator_lock(config.OPERATOR_LOCK)
    except guard.Busy as e:
        print(f"probe skipped: {e}", flush=True)
        return 3
    batch = [s | {"url": sources.template(s["url"])} for s in todo[:left]]
    try:
        rows = asyncio.run(asyncio.wait_for(collect.probe(batch, config.DATA / "snapshots" /
                                                          f"probe-{started:%Y%m%d-%H%M%S}"), timeout=300))
    except Exception as e:  # noqa: BLE001
        rows = [{"source_id": s["id"], "status": "error", "detail": f"{type(e).__name__}"} for s in batch]
    finally:
        guard.release(fd)
    for row in rows:
        report_probe(db, row, at)
    return 0


def report_probe(db, row: dict, at: str) -> None:
    sid = row["source_id"]
    text = Path(row["text_path"]).read_text() if row.get("status") == "ok" and row.get("text_path") else ""
    sample, why = sources.sanitize(text) if text else (None, row.get("detail") or row.get("status") or "not read")
    ok = bool(sample)
    try:
        sources.post_probe(sid, ok, row.get("url", ""), row.get("title", ""), sample or "", "" if ok else why)
    except Exception as e:  # noqa: BLE001
        print(f"probe {sid}: report failed {type(e).__name__}", flush=True)
    sources.record_probe(db, at, sid, "ok" if ok else f"rejected: {why}"[:200])
    print(json.dumps({"probe": sid, "ok": ok, "reason": "" if ok else why}, ensure_ascii=False), flush=True)


def skipped(started, reason: str) -> int:
    """A guard stopped the run: still record and push it, so the cockpit sees a skipped day, not silence."""
    print(f"skipped: {reason}", flush=True)
    run_id = started.strftime("%Y%m%d-%H%M%S")
    db = store.connect(config.DB)
    store.start_run(db, run_id, started.isoformat(timespec="seconds"))
    store.finish_run(db, run_id, collect.now().isoformat(timespec="seconds"), "skipped", {"skipped": reason})
    config.load_env()
    push(db, run_id)
    try:
        from .pms import push_configured
        pms = push_configured()
        if pms:
            print(json.dumps({"pms": pms}), flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"PMS aggregate import failed: {type(e).__name__}", flush=True)
    return 3


def not_reached(db, run_id: str, only: set[str] | None, outcome: str) -> None:
    """After a timeout or crash, give every platform the run never finished a page row saying so."""
    done = {c for (c,) in db.execute("SELECT DISTINCT cid FROM snapshots WHERE run_id=?", (run_id,))}
    for p in PLATFORMS:
        if (only and p.cid not in only) or p.cid in done:
            continue
        store.add_snapshot(db, run_id=run_id, cid=p.cid, slug="landing", captured_at=collect.now().isoformat(timespec="seconds"),
                           url=p.landing, status="error", detail=f"not read: the run {outcome} before this platform")


def push(db, run_id: str, attempts: int = 3) -> None:
    """Send the run to the cockpit; a short network blip should not lose the day's run proof."""
    for i in range(attempts):
        try:
            print(json.dumps({"cockpit": cockpit.push_run(db, run_id)}), flush=True)
            return
        except Exception as e:  # noqa: BLE001
            print(f"cockpit push failed ({i + 1}/{attempts}): {type(e).__name__}: {e}", flush=True)
            if i + 1 < attempts:
                time.sleep(PUSH_RETRY_S * (i + 1))


def after(db, run_id: str, report: bool = True) -> None:
    """Read numbers off the pages, send aggregates to the cockpit, then write the day's analysis report.

    Failures here never fail the run."""
    config.load_env()
    try:
        extract.extract_run(db, run_id)
    except Exception as e:  # noqa: BLE001
        print(f"extract failed: {type(e).__name__}: {e}", flush=True)
    push(db, run_id)
    try:
        print(json.dumps({"builtin_sources": sources.post_builtin(db, run_id)}), flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"builtin sources push failed: {type(e).__name__}", flush=True)
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
    ap.add_argument("--probe-sources", action="store_true", help="probe newly approved agent sources now")
    ap.add_argument("--after", metavar="RUN_ID", help="re-run extraction, cockpit push and the daily report for a past run")
    a = ap.parse_args()
    only = {s.strip() for s in a.platforms.split(",") if s.strip()} or None
    if a.plan:
        plan(only)
        return 0
    if a.once:
        return once(only)
    if a.probe_sources:
        return probe_sources()
    if a.after:
        after(store.connect(config.DB), a.after)
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
