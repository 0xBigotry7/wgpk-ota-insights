"""The collector must never be able to click, type, fill, sign in or launch/quit a browser."""
import ast
from pathlib import Path

PKG = Path(__file__).resolve().parents[1] / "ota"
FORBIDDEN_ATTRS = {"click", "dblclick", "fill", "type", "press", "press_sequentially", "check", "uncheck",
                   "select_option", "set_input_files", "set_checked", "dispatch_event", "tap", "hover", "focus",
                   "keyboard", "mouse", "touchscreen", "launch", "launch_persistent_context", "add_init_script",
                   "expose_function", "route", "set_extra_http_headers", "add_cookies", "clear_cookies"}


def attrs(path: Path) -> set[str]:
    return {n.attr for n in ast.walk(ast.parse(path.read_text())) if isinstance(n, ast.Attribute)}


def test_no_interaction_calls_anywhere():
    for f in PKG.glob("*.py"):
        bad = attrs(f) & FORBIDDEN_ATTRS
        assert not bad, f"{f.name} uses {sorted(bad)}"


def test_only_readonly_module_runs_script_and_only_the_fixed_one():
    for f in PKG.glob("*.py"):
        tree = ast.parse(f.read_text())
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Attribute) and n.attr == "evaluate"]
        if f.name != "readonly.py":
            assert not calls, f"{f.name} evaluates script"
    src = (PKG / "readonly.py").read_text()
    assert src.count(".evaluate(") == 1 and "evaluate(LINKS_JS)" in src


def test_collector_never_quits_chrome():
    src = (PKG / "collect.py").read_text()
    assert "browser.close(" not in src and "quit_chrome" not in src and "kill" not in src


def test_no_review_operator_imports():
    for f in PKG.glob("*.py"):
        assert "operator_v2" not in f.read_text().replace("wgpk-reviews/operator_v2", "")
