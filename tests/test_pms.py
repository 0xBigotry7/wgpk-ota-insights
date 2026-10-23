"""Source-date and scope guardrails for the aggregate OPERA bridge."""
import json

import pytest

from ota.pms import make_snapshot, number, raw_rows


def legacy(tmp_path, **kw):
    data = {"exported": "2026-07-28", "rows": [
        {"date": "2026-07-27", "kind": "history", "inv": 100, "rooms": 20,
         "revenue": 20000, "adr": 1000, "occ": 20, "guest_name": "must never leave"}]}
    data.update(kw)
    path = tmp_path / "daily.json"
    path.write_text(json.dumps(data))
    return path


def test_preserve_export_date_strip_unknown_fields_and_identity(tmp_path):
    path = legacy(tmp_path)
    a = make_snapshot(path)
    assert a["snapshot"]["as_of"] == "2026-07-28"
    assert a["snapshot"]["currency"] is None
    assert "guest_name" not in json.dumps(a)
    assert a == make_snapshot(path)
    assert a["snapshot"]["id"] != make_snapshot(path, currency="THB")["snapshot"]["id"]


def test_no_import_time_fallback_or_duplicate_scope(tmp_path):
    with pytest.raises(ValueError, match="report date"):
        make_snapshot(legacy(tmp_path, exported=""))
    path = legacy(tmp_path)
    data = json.loads(path.read_text())
    data["rows"].append(data["rows"][0])
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="duplicate"):
        make_snapshot(path)


def test_future_actuals_rejected_and_projection_not_renamed_actual(tmp_path):
    path = legacy(tmp_path, exported="2026-07-01")
    with pytest.raises(ValueError, match="actuals"):
        make_snapshot(path)
    data = json.loads(path.read_text())
    data["rows"][0]["kind"] = "forecast"
    path.write_text(json.dumps(data))
    assert make_snapshot(path)["rows"][0]["kind"] == "pms_projection"


def test_raw_report_numeric_parsing_and_unsupported_guest_report():
    report = "REC_TYPE\tCONSIDERED_DATE\tCF_OCCUPANCY\tCF_AVERAGE_ROOM_RATE\tREVENUE\tNO_ROOMS\tINVENTORY_ROOMS\nA_STAT\t27-JUL-26\t20\t1,000.00\t20,000\t20\t100"
    assert raw_rows(report)[0]["room_revenue"] == 20000
    with pytest.raises(ValueError, match="history_forecast"):
        raw_rows("ROOM\tGUEST\n101\tPrivate")
    for value in [True, float("nan"), "inf", "not number"]:
        with pytest.raises(ValueError):
            number(value)
    assert number("") is None


def test_optional_automatic_bridge_does_nothing_without_config(monkeypatch):
    from ota.pms import push_configured
    monkeypatch.delenv("WGPK_PMS_AGGREGATE_FILE", raising=False)
    assert push_configured() is None


def test_optional_bridge_uses_source_date_and_never_accepts_raw_guest_feeds(monkeypatch, tmp_path):
    from ota import pms
    path = legacy(tmp_path)
    captured = []
    monkeypatch.setenv("WGPK_PMS_AGGREGATE_FILE", str(path))
    monkeypatch.setattr(pms.cockpit, "post", lambda route, body: captured.append((route, body)) or {"ok": True})
    assert pms.push_configured() == {"ok": True}
    assert captured[0][0] == "/api/pms"
    assert captured[0][1]["snapshot"]["as_of"] == "2026-07-28"
    monkeypatch.setenv("WGPK_PMS_AGGREGATE_FILE", str(tmp_path / "inhouse.xml"))
    with pytest.raises(ValueError, match="curated JSON"):
        pms.push_configured()
