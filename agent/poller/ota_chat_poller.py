#!/usr/bin/env python3
"""Answer dashboard copilot questions with the OpenClaw `ota` agent.

Every POLL_S seconds: if the local OpenClaw gateway is healthy, claim the next queued question
(GET /api/agent/chat/next, which is also the agent's heartbeat), run one `openclaw agent --agent ota` turn
with a hard deadline, and POST the reply. While the gateway is down nothing is claimed, so the dashboard stops
seeing a heartbeat after 180 s and answers with its own model instead of queueing to a dead agent.
Logs never contain message text or the token.
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

# The skill's exec tool has no .py suffix, so load it with an explicit source loader.
_API = str(Path(__file__).resolve().parent.parent / "skills" / "ota-cockpit" / "ota-api")
_spec = importlib.util.spec_from_loader("ota_api", importlib.machinery.SourceFileLoader("ota_api", _API))
ota_api = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ota_api)  # type: ignore[union-attr]

OPENCLAW = os.environ.get("OPENCLAW_BIN", str(Path.home() / ".local" / "node" / "bin" / "openclaw"))
POLL_S = 7
TURN_S = 60               # the dashboard gives up at 75 s
MODEL = "openai/gpt-6.1-sol"
PROMPT = """驾驶舱里有人问你问题。先用 ota-cockpit 技能读 /api/agent/brief，必要时再查其它接口，然后用中文回答。
只输出一个 JSON 对象：{{"reply": "回答，可用 - 列表和 **粗体**，不超过 400 字", "actions": [最多 4 条
{{"type": "todo", "title": "...", "owner": "收益/销售|前台|客房|工程|餐饮|市场/内容|总经理", "platform": "...", "detail": "...", "evidence_ids": [...]}}]}}
{stay_date}对话：
{conversation}
"""


def log(msg: str) -> None:
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def gateway_ok() -> bool:
    try:
        return subprocess.run([OPENCLAW, "gateway", "status"], capture_output=True, timeout=15).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def run_turn(request: dict) -> dict | None:
    convo = "\n".join(f"{m.get('role')}: {m.get('content')}" for m in request.get("messages", [])[-10:])
    hint = f"用户正在看入住日 {request['stay_date']}。\n" if request.get("stay_date") else ""
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(PROMPT.format(stay_date=hint, conversation=convo))
        path = f.name
    try:
        p = subprocess.run([OPENCLAW, "agent", "--agent", "ota", "--message-file", path, "--json",
                            "--timeout", str(TURN_S), "--session-key", f"agent:ota:dashboard-{request['id']}"],
                           capture_output=True, text=True, timeout=TURN_S + 5)
    except subprocess.TimeoutExpired:
        log(f"chat {request['id']}: agent turn timed out")
        return None
    finally:
        os.unlink(path)
    if p.returncode != 0:
        log(f"chat {request['id']}: openclaw exit {p.returncode}")
        return None
    return parse_reply(p.stdout)


def parse_reply(stdout: str) -> dict | None:
    """The agent's final text, from `openclaw agent --json`; must itself be the JSON object asked for."""
    try:
        out = json.loads(stdout)
    except json.JSONDecodeError:
        return None
    text = out.get("reply") or out.get("text") or out.get("message") or ""
    result = out.get("result")
    if isinstance(result, dict):
        # openclaw agent --json: {"result": {"payloads": [{"text": ...}], "meta": {...}}}
        payloads = [p.get("text") or "" for p in result.get("payloads") or [] if isinstance(p, dict)]
        text = "\n".join(t for t in payloads if t) or result.get("text") or text
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {"reply": text.strip()[:3000], "actions": []} if text.strip() else None
    try:
        obj = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return {"reply": text.strip()[:3000], "actions": []}
    if not isinstance(obj.get("reply"), str):
        return None
    return {"reply": obj["reply"][:3000], "actions": [a for a in obj.get("actions") or [] if isinstance(a, dict)][:4]}


def once() -> None:
    if not gateway_ok():
        return
    status, body = ota_api.call("GET", "/api/agent/chat/next", None, timeout=15)
    if status != 200:
        log(f"chat/next HTTP {status}")
        return
    request = (json.loads(body) or {}).get("request")
    if not request:
        return
    answer = run_turn(request)
    if not answer:
        return
    status, _ = ota_api.call("POST", f"/api/agent/chat/{int(request['id'])}",
                             json.dumps(answer | {"model": MODEL}, ensure_ascii=False).encode(), timeout=15)
    log(f"chat {request['id']}: answered, HTTP {status}")


def main() -> None:
    while True:
        try:
            once()
        except Exception as e:  # noqa: BLE001 - keep polling
            log(f"error {type(e).__name__}")
        time.sleep(POLL_S)


if __name__ == "__main__":
    main()
