"""The owner relay: Gary hears, once, when someone else asks the ota agent for work; never replays history."""
import importlib.util
import json
import sqlite3
from pathlib import Path

spec = importlib.util.spec_from_file_location("owner_relay", Path(__file__).parent.parent / "agent/relay/owner_relay.py")
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)

HK = "agent:ota:telegram:direct:5067642721"


def user(text, sender="5067642721"):
    return {"type": "message", "message": {"role": "user", "content": text,
                                           "__openclaw": {"senderId": sender, "senderName": "HK"}}}


def tool(command):
    return {"type": "message", "message": {"role": "assistant", "content": [
        {"type": "toolCall", "name": "exec", "arguments": {"command": command}}]}}


def said(text):
    return {"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}


def setup(tmp_path, monkeypatch):
    db = tmp_path / "agent.sqlite"
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE session_windows (session_id TEXT, session_key TEXT)")
    c.execute("CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT)")
    c.executemany("INSERT INTO session_windows VALUES (?, ?)", [("hk", HK), ("gary", "agent:ota:telegram:direct:2078847155")])
    c.commit()
    monkeypatch.setattr(relay, "DB", db)
    monkeypatch.setattr(relay, "STATE", tmp_path / "state.json")
    return c


def add(c, sid, start, events, at):
    c.executemany("INSERT INTO transcript_events VALUES (?, ?, ?, ?)",
                  [(sid, start + i, at, json.dumps(e)) for i, e in enumerate(events)])
    c.commit()


def test_history_is_not_replayed_then_new_work_is_told_once(tmp_path, monkeypatch):
    c = setup(tmp_path, monkeypatch)
    add(c, "hk", 0, [{"type": "session"}, user("我想先看看整体运营状况"), said("好的")], 1_000)
    out = []
    assert relay.run_once(10**9, out.append) == 0                     # first run only records the position
    add(c, "hk", 3, [user("请逐个渠道分析并建待办"), tool("ota-api POST /api/agent/todos '{...}'"),
                     said("已建 4 项待办：Booking 11 月、携程下单……")], 2_000_000)
    add(c, "gary", 0, [user("你好", sender="2078847155"), said("hi")], 2_000_000)
    assert relay.run_once(2_000_000 + 30_000, out.append) == 0        # still settling
    assert relay.run_once(2_000_000 + 61_000, out.append) == 1
    assert out == ["老姚让我：请逐个渠道分析并建待办\n我做了：建/改待办——已建 4 项待办：Booking 11 月、携程下单……"]
    assert relay.run_once(2_000_000 + 600_000, out.append) == 0       # told once


def test_pure_chat_gets_no_notice(tmp_path, monkeypatch):
    c = setup(tmp_path, monkeypatch)
    relay.run_once(0, lambda s: None)
    add(c, "hk", 0, [user("/start"), said("你好"), user("谢谢"), said("不客气")], 1_000)
    out = []
    assert relay.run_once(10**9, out.append) == 0 and out == []
