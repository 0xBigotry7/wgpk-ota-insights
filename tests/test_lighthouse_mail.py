"""ota.lighthouse_mail: inbox API polling (no network) with a tiny synthetic Market Insight workbook."""

import hashlib
import io
import json
import sqlite3
import zipfile

from ota import lighthouse_mail as lm


def _sheet(rows):
    def cell(r, c, v):
        ref = f"{chr(65 + c)}{r}"
        if v is None:
            return f'<c r="{ref}"/>'
        if isinstance(v, (int, float)):
            return f'<c r="{ref}"><v>{v}</v></c>'
        return f'<c r="{ref}" t="inlineStr"><is><t>{v}</t></is></c>'

    body = "".join(
        f'<row r="{i + 1}">' + "".join(cell(i + 1, j, v) for j, v in enumerate(row)) + "</row>"
        for i, row in enumerate(rows)
    )
    return f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{body}</sheetData></worksheet>'


def market_xlsx(price=6380.0):
    head = [None, None, None, f"Market Insight - {lm.PROPERTY} - THB"]
    daily = [head, [], [], [], ["Date", "Demand level", "My price", "My OTB", "Market OTB"],
             [46346.0, "High", price, 0.71, 0.65], [46347.0, "Medium", 6044.0, 0.68, 0.6]]
    geo = [[], [], [], [], ["Top 10 countries searching for hotels"], ["Thailand"]]
    stay = [[], [], [], [], ["LOS bucket"], ["1 night"]]
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rel = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    names = ["Daily details", "Geo breakdown", "Stay pattern breakdown"]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/workbook.xml", f"<workbook {ns} {rel}><sheets>" + "".join(
            f'<sheet name="{n}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, n in enumerate(names)) + "</sheets></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + "".join(
                       f'<Relationship Id="rId{i + 1}" Target="worksheets/sheet{i + 1}.xml"/>' for i in range(3))
                   + "</Relationships>")
        for i, rows in enumerate((daily, geo, stay)):
            z.writestr(f"xl/worksheets/sheet{i + 1}.xml", _sheet(rows))
    return buf.getvalue()


def fake_inbox(monkeypatch, tmp_path, files):
    token = tmp_path / "token"
    token.write_text("t0ken\n")
    monkeypatch.setattr(lm, "INBOX_TOKEN_FILE", token)
    messages = [{"id": f"{i:064x}", "received_at": f"2026-11-1{i}T01:30:00.000Z", "attachments": [
        {"id": f"{i:024x}-1", "filename": "Market Insight.xlsx", "bytes": len(raw), "duplicate_of": None,
         "sha256": hashlib.sha256(raw).hexdigest(), "url": f"/api/attachments/{i:024x}-1"}]}
        for i, raw in enumerate(files, start=1)]
    calls = []

    def get(path, tok):
        assert tok == "t0ken"
        calls.append(path)
        if path.startswith("/api/messages?"):
            since = dict(p.split("=", 1) for p in path.split("?", 1)[1].split("&"))["since"].replace("%3A", ":")
            page = [m for m in messages if m["received_at"] > since]
            return json.dumps({"messages": page, "next_since": page[-1]["received_at"] if page else since or None,
                               "has_more": False}).encode()
        return files[int(path.rsplit("/", 1)[-1].split("-")[0], 16) - 1]

    monkeypatch.setattr(lm, "_inbox_get", get)
    return calls


def test_poll_inbox_archives_new_xlsx_once_and_compares(monkeypatch, tmp_path):
    fake_inbox(monkeypatch, tmp_path, [market_xlsx(6380.0), market_xlsx(6500.0)])
    db = sqlite3.connect(tmp_path / "lh.sqlite")
    assert lm.poll_inbox(db) == 2
    assert lm.poll_inbox(db) == 0                      # cursor: nothing new on the next tick
    latest = lm.latest(db, "market")
    assert latest["daily"][0]["Date"] == "2026-11-20" and latest["daily"][0]["My price"] == 6500.0
    diff = lm.compare_market(db)
    assert diff["changes"][0]["My price"] == 120.0
    assert lm.latest(db, "events") is None


def test_poll_inbox_rejects_checksum_mismatch(monkeypatch, tmp_path):
    raw = market_xlsx()
    fake_inbox(monkeypatch, tmp_path, [raw])
    monkeypatch.setattr(lm, "_inbox_get", (lambda orig: lambda p, t: orig(p, t) if p.startswith("/api/messages")
                                           else raw + b"x")(lm._inbox_get))
    db = sqlite3.connect(tmp_path / "lh.sqlite")
    try:
        lm.poll_inbox(db)
    except RuntimeError as exc:
        assert "checksum" in str(exc)
    else:
        raise AssertionError("expected a checksum error")


def test_samples_never_count_as_live(tmp_path):
    db = sqlite3.connect(tmp_path / "lh.sqlite")
    lm.archive(db, market_xlsx(), "2026-11-11T00:00:00+00:00", "local_sample")
    assert lm.latest(db, "market") is None
