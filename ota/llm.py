"""One JSON-schema call to the ChatGPT account signed in on this Mac (codex exec, read-only, ephemeral)."""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from . import config


def ask_json(prompt: str, schema: dict, timeout: int = 240) -> dict:
    with tempfile.TemporaryDirectory(prefix="wgpk-ota-") as d:
        schema_path, out = Path(d) / "schema.json", Path(d) / "last.txt"
        schema_path.write_text(json.dumps(schema))
        p = subprocess.run(
            [config.CODEX_BIN, "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--color", "never",
             "--output-schema", str(schema_path), "-o", str(out), "-"],
            input=prompt, capture_output=True, text=True, timeout=timeout, cwd=d)
        if p.returncode != 0 or not out.exists():
            raise RuntimeError(f"codex exec rc={p.returncode}: {(p.stderr or '')[-300:]}")
        txt = out.read_text().strip()
        if txt.startswith("```"):
            txt = txt.strip("`").split("\n", 1)[1]
        return json.loads(txt)
