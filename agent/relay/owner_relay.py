#!/usr/bin/env python3
"""Tell Gary on Telegram when someone else asks the ota agent for work.

Gary (2078847155) runs the ota agent; other people on its Telegram allowlist (老姚, the owner) may ask it things
too. Gary wants one line each time: "<name>让我：… ／我做了：…". The agent itself is not given a message tool
(OpenClaw cannot limit that tool to one chat or one bot); instead this script reads the ota agent's own session
store read-only, finds finished turns from other senders, and sends Gary one line through the ota bot.

Run every minute by launchd (com.wgpk.ota-owner-relay). The first run only records where each conversation is,
so history is never replayed. Logs never contain message text or the token.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

GARY = "2078847155"
HOME = Path.home()
DB = Path(os.environ.get("OTA_AGENT_DB", HOME / ".openclaw/agents/ota/agent/openclaw-agent.sqlite"))
STATE = Path(os.environ.get("OTA_RELAY_STATE", HOME / ".config/wgpk-ota-agent/relay-state.json"))
TOKEN_FILE = Path(os.environ.get("OTA_BOT_TOKEN_FILE", HOME / ".config/wgpk-ota-agent/telegram_bot_token"))
NODE = os.environ.get("OTA_NODE_BIN", str(HOME / ".local/node/bin/node"))   # Node 24 has zstd; Python 3.9 does not
SETTLE_S = 180            # a turn counts as finished when nothing was added to it for this long (long tool calls)
KEY = re.compile(r"^agent:ota:telegram(?::ota)?:direct:(\d+)$")
# What the agent did, recognised from its ota-api calls.
ACTIONS = (("POST /api/agent/todos", "建/改待办"), ("POST /api/agent/notes", "记笔记"),
           ("POST /api/agent/refresh", "请采集补读"), ("POST /api/agent/sources", "申请新数据页"))


def log(msg: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


def turns(events: list[tuple[int, int, dict]]) -> list[dict]:
    """Group a session's events into turns: one user message and what the agent did and said after it."""
    out: list[dict] = []
    for seq, created, e in events:
        m = e.get("message") if e.get("type") == "message" else None
        if not isinstance(m, dict):
            if out:
                out[-1]["last_seq"], out[-1]["last_at"] = seq, created
            continue
        if m.get("role") == "user":
            meta = m.get("__openclaw") or {}
            out.append({"first_seq": seq, "last_seq": seq, "last_at": created, "ask": _text(m.get("content")).strip(),
                        "sender": str(meta.get("senderId") or ""), "name": meta.get("senderName") or "", "actions": [],
                        "reply": ""})
            continue
        if not out:
            continue
        t = out[-1]
        t["last_seq"], t["last_at"] = seq, created
        for p in m.get("content") or []:
            if isinstance(p, dict) and p.get("type") in ("toolCall", "tool_use"):
                args = json.dumps(p.get("arguments") or p.get("input") or {}, ensure_ascii=False)
                for needle, label in ACTIONS:
                    if needle in args and label not in t["actions"]:
                        t["actions"].append(label)
        said = _text(m.get("content")).strip()
        if m.get("role") == "assistant" and said:
            t["reply"] = said
    return out


WORK = re.compile(r"[?？]|分析|看看|看下|查|建|做|帮|为什么|多少|怎么|哪|是否|有没有|能不能|安排|整理|报告|方案|对比|预测|"
                  r"analy|check|why|how|what|when|which|report|plan", re.I)


def worth_telling(t: dict) -> bool:
    """Pure chat (/start, a greeting, "call me Hank") gets no notice; a request for work does: the agent acted
    (to-dos, notes, refresh, sources) or the message reads like a question or a task."""
    ask = t["ask"]
    if not ask or ask.startswith("/"):
        return False
    return bool(t["actions"]) or bool(WORK.search(ask))


def unzstd(blobs: list[bytes]) -> list[str | None]:
    """OpenClaw stores long events zstd-compressed (event_json NULL); decompress them with the local Node."""
    if not blobs:
        return []
    script = ("const z=require('zlib');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{"
              "process.stdout.write(JSON.stringify(JSON.parse(s).map(h=>{try{return z.zstdDecompressSync(Buffer.from(h,'hex')).toString()}"
              "catch(e){return null}})))})")
    try:
        p = subprocess.run([NODE, "-e", script], input=json.dumps([b.hex() for b in blobs]), capture_output=True,
                           text=True, timeout=30)
        out = json.loads(p.stdout) if p.returncode == 0 else []
    except (OSError, ValueError, subprocess.TimeoutExpired):
        out = []
    return out if len(out) == len(blobs) else [None] * len(blobs)


def events(rows: list[tuple]) -> list[tuple[int, int, dict]]:
    """(seq, created_at, event) for rows of (seq, created_at, event_json, event_zstd, navigation_json)."""
    texts = unzstd([z for _, _, j, z, _ in rows if j is None and z is not None])
    out, i = [], 0
    for seq, created, j, z, nav in rows:
        if j is None and z is not None:
            j, i = texts[i], i + 1
            if j is None:                         # cannot decompress: keep its shape from the navigation summary
                try:
                    j = json.dumps(json.loads(nav or "{}").get("navigation") or {})
                except ValueError:
                    j = "{}"
        try:
            out.append((seq, created, json.loads(j or "{}")))
        except ValueError:
            continue
    return out


def clip(s: str, n: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


TG_MAX = 3900             # Telegram allows 4096 characters a message; leave room for the "(2/3)" mark


def plain(s: str) -> str:
    """The copy is sent as plain text, so drop the Markdown marks Telegram would show raw."""
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s, flags=re.S)
    s = re.sub(r"^#{1,6}\s+", "", s, flags=re.M)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def line(t: dict) -> str:
    """Gary gets the agent's whole answer (TG 13920): a clipped copy hides how it really answered."""
    who = "老姚" if t["sender"] == "5067642721" else (t["name"] or t["sender"])
    did = "、".join(t["actions"]) if t["actions"] else "回答了"
    return f"{who}让我：{clip(t['ask'], 600)}\n\n我做了：{did}\n{plain(t['reply']) or '（还在处理）'}"


def parts(text: str, n: int = TG_MAX) -> list[str]:
    """Split a long copy at line breaks into messages Telegram accepts."""
    out, cur = [], ""
    for ln in text.split("\n"):
        while len(ln) > n:                                    # one very long line: cut it
            if cur:
                out.append(cur)
                cur = ""
            out.append(ln[:n])
            ln = ln[n:]
        if cur and len(cur) + 1 + len(ln) > n:
            out.append(cur)
            cur = ln
        else:
            cur = f"{cur}\n{ln}" if cur else ln
    if cur:
        out.append(cur)
    out = [o for o in out if o.strip()]
    return out if len(out) <= 1 else [f"({i}/{len(out)}) {o}" for i, o in enumerate(out, 1)]


def send(text: str) -> None:
    """Send one message (one part of a copy) to Gary."""
    token = TOKEN_FILE.read_text().strip()
    data = urllib.parse.urlencode({"chat_id": GARY, "text": text, "disable_web_page_preview": "true"}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        if not json.load(r).get("ok"):
            raise RuntimeError("telegram send not ok")


DB_TIMEOUT_S = 15
DB_RETRIES = 3
DB_RETRY_DELAY_S = 0.5


def _wal_sidecars_absent(path: Path) -> bool:
    wal = Path(f"{path}-wal")
    shm = Path(f"{path}-shm")
    wal_empty = not wal.exists() or wal.stat().st_size == 0
    return path.exists() and wal_empty and not shm.exists()


def _open_immutable(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True, timeout=DB_TIMEOUT_S)
    try:
        con.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
        return con
    except sqlite3.OperationalError:
        con.close()
        raise


def open_db(path: Path, retries: int = DB_RETRIES, retry_delay: float = DB_RETRY_DELAY_S) -> sqlite3.Connection:
    """Open the OpenClaw session DB read-only.

    OpenClaw runs SQLite in WAL mode and periodically clean-closes the DB, which checkpoints and unlinks the
    -wal/-shm sidecars. SQLite refuses plain `?mode=ro` on a WAL DB when -shm is absent (`unable to open database
    file`) or may recreate `-shm`. When the DB exists and has no `-shm` and no non-empty `-wal`, opening with
    `mode=ro&immutable=1` reads the complete checkpointed state without creating sidecar files or disturbing
    OpenClaw's clean-close receipt. Transient lock or checkpoint races are retried with a busy timeout.
    """
    last_err: sqlite3.OperationalError | None = None
    for attempt in range(retries):
        if _wal_sidecars_absent(path):
            try:
                return _open_immutable(path)
            except sqlite3.OperationalError as err:
                last_err = err
                if attempt + 1 < retries:
                    time.sleep(retry_delay * (attempt + 1))
                continue
        con: sqlite3.Connection | None = None
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=DB_TIMEOUT_S)
            con.execute(f"PRAGMA busy_timeout = {DB_TIMEOUT_S * 1000}")
            con.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
            return con
        except sqlite3.OperationalError as err:
            if con is not None:
                con.close()
            last_err = err
            wal = Path(f"{path}-wal")
            wal_empty = not wal.exists() or wal.stat().st_size == 0
            if path.exists() and wal_empty and "unable to open" in str(err).lower():
                return _open_immutable(path)
            if attempt + 1 < retries:
                time.sleep(retry_delay * (attempt + 1))
    assert last_err is not None
    raise last_err


def run_once(now_ms: int | None = None, sender=send) -> int:
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    state = json.loads(STATE.read_text()) if STATE.exists() else None
    first = state is None
    state = state or {}

    def save() -> None:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE.with_suffix(".tmp")
        tmp.write_text(json.dumps(state))
        os.chmod(tmp, 0o600)
        tmp.replace(STATE)

    db = open_db(DB)
    sent = 0
    try:
        sessions = db.execute("SELECT session_id, session_key FROM session_windows").fetchall()
        for sid, key in sessions:
            m = KEY.match(key or "")
            if not m or m.group(1) == GARY:
                continue
            cursor = int(state.get(sid, -1))
            rows = db.execute("SELECT seq, created_at, event_json, event_zstd, navigation_json FROM transcript_events "
                              "WHERE session_id = ? AND seq > ? ORDER BY seq", (sid, cursor)).fetchall()
            if first:
                state[sid] = rows[-1][0] if rows else cursor     # start from now; never replay history
                continue
            for t in turns(events(rows)):
                if now_ms - t["last_at"] < SETTLE_S * 1000:
                    break                                         # still running: look again next minute
                state[sid] = t["last_seq"]
                if t["sender"] != GARY and worth_telling(t):
                    part_key = f"parts:{sid}:{t['first_seq']}"       # parts of this copy Gary already has
                    todo = parts(line(t))
                    try:
                        for i in range(int(state.get(part_key, 0)), len(todo)):
                            sender(todo[i])
                            state[part_key] = i + 1
                            save()                                # a later failure never resends this part
                    except Exception:
                        state[sid] = t["first_seq"] - 1            # not finished: send the rest next minute
                        raise
                    state.pop(part_key, None)
                    sent += 1
                    save()                                        # a later failure never resends this line
    finally:
        db.close()
        save()
    return sent


if __name__ == "__main__":
    try:
        n = run_once()
        if n:
            log(f"told Gary about {n} request(s)")
    except Exception as e:  # noqa: BLE001 - next minute tries again
        detail = f": {e}" if isinstance(e, sqlite3.Error) else ""
        log(f"relay error: {type(e).__name__}{detail}")
        sys.exit(1)
