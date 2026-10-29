"""What a run records and pushes when it does not finish normally."""
import datetime as dt

from ota import cockpit, collect, config, guard, refresh, run, store

BKK = dt.timezone(dt.timedelta(hours=7))


def setup(tmp_path, monkeypatch, now):
    monkeypatch.setattr(config, "DB", tmp_path / "ota.sqlite")
    monkeypatch.setattr(config, "load_env", lambda: None)
    monkeypatch.setattr(collect, "now", lambda: now)
    monkeypatch.setattr(run, "PUSH_RETRY_S", 0)
    monkeypatch.setattr(run, "agent_pages", lambda: {})           # no cockpit calls in tests
    monkeypatch.setattr(run, "probe_sources", lambda: 0)
    monkeypatch.setattr(refresh, "claim", lambda: None)            # no agent refresh waiting
    pushed = []
    monkeypatch.setattr(cockpit, "push_run", lambda db, rid: pushed.append(cockpit.payload(db, rid)) or {"ok": True})
    return pushed


def test_guard_skip_is_recorded_and_pushed(tmp_path, monkeypatch):
    pushed = setup(tmp_path, monkeypatch, dt.datetime(2026, 10, 24, 9, 0, tzinfo=BKK))
    assert run.once(None) == 3
    assert pushed and pushed[0]["run"]["outcome"] == "skipped" and pushed[0]["pages"] == []
    assert store.done_run_on(store.connect(config.DB), "20261024") is None   # the fallback slot still runs


def test_timeout_marks_platforms_not_reached(tmp_path, monkeypatch):
    pushed = setup(tmp_path, monkeypatch, dt.datetime(2026, 10, 24, 10, 20, tzinfo=BKK))
    monkeypatch.setattr(run, "cdp_alive", lambda port: True)
    monkeypatch.setattr(guard, "take_operator_lock", lambda path: None)
    monkeypatch.setattr(guard, "release", lambda fd: None)
    monkeypatch.setattr(run, "after", lambda db, rid, report=True: run.push(db, rid))

    def half_then_timeout(only, run_id, db, extra=None):
        store.add_snapshot(db, run_id=run_id, cid="booking", slug="landing", captured_at="x", status="ok")
        raise TimeoutError

    monkeypatch.setattr(collect, "run_with_deadline", half_then_timeout)
    assert run.once(None) == 1
    pages = {(p["platform"], p["status"]) for p in pushed[0]["pages"]}
    assert ("booking", "ok") in pages and ("medallia", "error") in pages
    assert pushed[0]["run"]["outcome"] == "timeout"


def test_push_retries_then_gives_up(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch, dt.datetime(2026, 10, 24, 10, 20, tzinfo=BKK))
    calls = []
    monkeypatch.setattr(cockpit, "push_run", lambda db, rid: calls.append(1) or (_ for _ in ()).throw(OSError("net")))
    run.push(store.connect(config.DB), "20261024-102000")
    assert len(calls) == 3


def test_second_pass_only_for_platforms_signed_out_this_morning(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch, dt.datetime(2026, 10, 25, 22, 15, tzinfo=BKK))
    db = store.connect(config.DB)
    store.start_run(db, "20261025-102000", "x")
    store.finish_run(db, "20261025-102000", "y", "done", {})
    store.add_snapshot(db, run_id="20261025-102000", cid="medallia", slug="landing", captured_at="x", status="signed_out")
    store.add_snapshot(db, run_id="20261025-102000", cid="booking", slug="landing", captured_at="x", status="ok")
    seen = {}
    monkeypatch.setattr(run, "cdp_alive", lambda port: True)
    monkeypatch.setattr(guard, "take_operator_lock", lambda path: None)
    monkeypatch.setattr(guard, "release", lambda fd: None)
    monkeypatch.setattr(collect, "run_with_deadline", lambda only, rid, db, extra=None: seen.setdefault("only", only) and {})
    monkeypatch.setattr(run, "after", lambda db, rid, report=True: seen.setdefault("report", report))
    assert run.once(None) == 0
    assert seen == {"only": {"medallia"}, "report": True}

    # Once Medallia has been read today, the 22:15 slot has nothing left to do.
    store.add_snapshot(db, run_id="20261025-221500", cid="medallia", slug="landing", captured_at="x", status="ok")
    seen.clear()
    assert run.once(None) == 0 and seen == {}


def test_schedule_avoids_every_review_desk_slot():
    import datetime as d
    slots = config.AVOID_SLOTS
    assert slots == ["09:15", "11:30", "13:45", "16:00", "18:15", "21:00"]
    for hh, mm in ((10, 20), (22, 15)):
        assert guard.near_review_window(d.datetime(2026, 10, 25, hh, mm, tzinfo=BKK), slots, 60) is None
    assert guard.near_review_window(d.datetime(2026, 10, 25, 11, 30, tzinfo=BKK), slots, 60) == "11:30"


def test_every_launchd_slot_is_outside_the_review_windows():
    import plistlib
    from pathlib import Path as P
    plist = plistlib.loads((P(__file__).resolve().parent.parent / "launchd" / "com.wgpk.ota-insights.plist").read_bytes())
    slots = plist["EnvironmentVariables"]["WGPK_OTA_AVOID"].split(",")
    for when in plist["StartCalendarInterval"]:
        at = dt.datetime(2026, 10, 29, when["Hour"], when["Minute"], tzinfo=BKK)
        assert guard.near_review_window(at, slots, 60) is None, at


def _done_today(db, day="20261029"):
    store.start_run(db, f"{day}-102000", "x")
    store.finish_run(db, f"{day}-102000", "y", "done", {})


def _browser_ok(monkeypatch, seen):
    monkeypatch.setattr(run, "cdp_alive", lambda port: True)
    monkeypatch.setattr(guard, "take_operator_lock", lambda path: None)
    monkeypatch.setattr(guard, "release", lambda fd: None)
    monkeypatch.setattr(collect, "run_with_deadline", lambda only, rid, db, extra=None: seen.setdefault("only", only) and {})
    monkeypatch.setattr(run, "after", lambda db, rid, report=True: seen.setdefault("report", report))


def test_agent_refresh_reads_only_the_asked_platforms_after_the_daily_run(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch, dt.datetime(2026, 10, 29, 12, 35, tzinfo=BKK))
    _done_today(store.connect(config.DB))
    seen, reports = {}, []
    _browser_ok(monkeypatch, seen)
    monkeypatch.setattr(refresh, "claim", lambda: {"id": 7, "platforms": {"booking"}, "reason": "老姚问 11 月"})
    monkeypatch.setattr(refresh, "report", lambda rid, status, run_id="", detail="": reports.append((rid, status, run_id)))
    probes = []
    monkeypatch.setattr(run, "probe_sources", lambda: probes.append(1) or 0)
    assert run.once(None) == 0
    assert seen == {"only": {"booking"}, "report": False}           # a partial read never rewrites the day's report
    assert reports == [(7, "done", "20261029-123500")]
    assert probes == [1]                                            # agent sources are still probed in the slot


def test_agent_refresh_near_a_review_window_goes_back_to_the_queue(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch, dt.datetime(2026, 10, 29, 13, 0, tzinfo=BKK))   # 45 min before 13:45
    _done_today(store.connect(config.DB))
    reports = []
    monkeypatch.setattr(refresh, "claim", lambda: {"id": 8, "platforms": {"agoda"}, "reason": "x"})
    monkeypatch.setattr(refresh, "report", lambda rid, status, run_id="", detail="": reports.append((rid, status)))
    assert run.once(None) == 3
    assert reports == [(8, "skipped")]


def test_daily_full_run_covers_a_waiting_refresh(tmp_path, monkeypatch):
    setup(tmp_path, monkeypatch, dt.datetime(2026, 10, 29, 10, 20, tzinfo=BKK))
    seen, reports = {}, []
    _browser_ok(monkeypatch, seen)
    monkeypatch.setattr(refresh, "claim", lambda: {"id": 9, "platforms": {"ctrip"}, "reason": "x"})
    monkeypatch.setattr(refresh, "report", lambda rid, status, run_id="", detail="": reports.append((rid, status, run_id)))
    assert run.once(None) == 0
    assert seen["only"] is None
    assert reports == [(9, "done", "20261029-102000")]
