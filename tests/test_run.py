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
