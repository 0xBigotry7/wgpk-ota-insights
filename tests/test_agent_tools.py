"""The ota agent's exec tool and the dashboard chat poller."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent / "agent"
_path = str(ROOT / "skills" / "ota-cockpit" / "ota-api")
spec = importlib.util.spec_from_loader("ota_api", importlib.machinery.SourceFileLoader("ota_api", _path))
ota_api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ota_api)


@pytest.mark.parametrize("argv", [
    ["GET", "/api/agent/brief"],
    ["get", "/api/agent/metrics?platform=booking&metric_prefix=pickup_90d&since=2026-10-01"],
    ["POST", "/api/agent/todos/12", '{"status": "done"}'],
    ["POST", "/api/agent/notes", '{"topic": "a", "note": "b"}'],
])
def test_allowed(argv):
    method, path, body = ota_api.validate(argv)
    assert method in ("GET", "POST") and path.startswith("/api/agent/")


@pytest.mark.parametrize("argv", [
    ["DELETE", "/api/agent/todos/1"],
    ["GET", "/api/state"],
    ["GET", "https://evil.example/api/agent/brief"],
    ["GET", "/api/agent/../state"],
    ["GET", "/api/agent//brief"],
    ["GET", "/api/agent/brief", '{"x": 1}'],
    ["POST", "/api/agent/notes", "[1, 2]"],
    ["POST", "/api/agent/notes", "not json"],
    ["POST", "/api/agent/notes", '{"note": "' + "x" * 9000 + '"}'],
    ["GET", "/api/agent/brief; rm -rf /"],
])
def test_refused(argv):
    with pytest.raises((ValueError, json.JSONDecodeError)):
        ota_api.validate(argv)


def test_token_never_printed(tmp_path, monkeypatch, capsys):
    env = tmp_path / "env"
    env.write_text("AGENT_TOKEN=s3cret-value\n")
    monkeypatch.setattr(ota_api, "ENV", env)
    monkeypatch.setattr(ota_api, "call", lambda m, p, b, timeout=30: (200, '{"ok": true}'))
    assert ota_api.main(["GET", "/api/agent/brief"]) == 0
    assert "s3cret" not in capsys.readouterr().out


def test_poller_parses_agent_json_reply():
    spec2 = importlib.util.spec_from_file_location("poller", ROOT / "poller" / "ota_chat_poller.py")
    poller = importlib.util.module_from_spec(spec2)
    spec2.loader.exec_module(poller)
    out = '{"reply": "好的 ```json {\\"reply\\": \\"Booking 点击率 2.57%\\", \\"actions\\": [{\\"type\\": \\"todo\\", \\"title\\": \\"t\\"}]} ```"}'
    got = poller.parse_reply(out)
    assert got["reply"] == "Booking 点击率 2.57%" and len(got["actions"]) == 1
    assert poller.parse_reply("not json") is None
