"""What a run records and pushes when it does not finish normally."""
import datetime as dt

from ota import cockpit, collect, config, guard, run, store

BKK = dt.timezone(dt.timedelta(hours=7))


def setup(tmp_path, monkeypatch, now):
    monkeypatch.setattr(config, "DB", tmp_path / "ota.sqlite")
    monkeypatch.setattr(config, "load_env", lambda: None)
    monkeypatch.setattr(collect, "now", lambda: now)
    monkeypatch.setattr(run, "PUSH_RETRY_S", 0)
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

    def half_then_timeout(only, run_id, db):
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
    monkeypatch.setattr(collect, "run_with_deadline", lambda only, rid, db: seen.setdefault("only", only) and {})
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
