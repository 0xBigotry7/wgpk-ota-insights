import sqlite3

from ota import cockpit, extract, store
from ota.catalog import CATALOG, Metric

M = {"review_score": Metric("review_score", "评分", "/10"), "review_count": Metric("review_count", "评论数")}


def test_keeps_only_numbers_that_are_on_the_page():
    text = "Review score 8.6 based on 1,234 reviews. Area average 8.1"
    kept = extract.check([
        {"key": "review_score", "value": 8.6, "benchmark": 8.1, "quote": "8.6"},
        {"key": "review_count", "value": 1234, "benchmark": 9.9, "quote": "1,234"},     # benchmark not on page
        {"key": "invented_key", "value": 8.6, "benchmark": None, "quote": ""},
    ], M, text)
    assert [(m.key, v, b) for m, v, b in kept] == [("review_score", 8.6, 8.1), ("review_count", 1234.0, None)]


def test_drops_hallucinated_values():
    assert extract.check([{"key": "review_score", "value": 9.2, "benchmark": None, "quote": "9.2"}], M,
                         "Review score 8.6") == []


def test_catalog_identity_is_unique_per_platform():
    # metric_values is keyed by (day, platform, metric, period): two pages must not write the same row.
    seen = {}
    for (cid, slug), metrics in CATALOG.items():
        for mt in metrics:
            assert (cid, mt.key, mt.period) not in seen, (cid, slug, mt.key, seen.get((cid, mt.key, mt.period)))
            seen[(cid, mt.key, mt.period)] = slug


def test_catalog_keys_are_snake_case_and_unique_per_page():
    for page, metrics in CATALOG.items():
        keys = [m.key for m in metrics]
        assert len(keys) == len(set(keys)), page
        assert all(k.replace("_", "").isalnum() and k.islower() for k in keys), page


def _db(tmp_path):
    db = store.connect(tmp_path / "t.sqlite")
    store.start_run(db, "20261022-163347", "2026-10-22T16:33:47+07:00")
    store.finish_run(db, "20261022-163347", "2026-10-22T16:40:00+07:00", "done", {})
    return db


def test_extract_skips_inbox_and_writes_checked_values(tmp_path):
    db = _db(tmp_path)
    page, inbox = tmp_path / "reviews.txt", tmp_path / "inbox.txt"
    page.write_text("Guest review score 8.6 from 1,234 reviews")
    inbox.write_text("Message from Jane Doe ... 3 unread")
    for slug, path in (("reviews", page), ("inbox", inbox)):
        store.add_snapshot(db, run_id="20261022-163347", cid="booking", slug=slug, captured_at="x", status="ok",
                           text_path=str(path))
    sent = []

    def ask(prompt, schema):
        sent.append(prompt)
        return {"values": [{"key": "review_score", "value": 8.6, "benchmark": None, "quote": "8.6"},
                           {"key": "review_count", "value": 1234, "benchmark": None, "quote": "1,234"}]}

    extract.extract_run(db, "20261022-163347", ask=ask)
    assert len(sent) == 1 and "Jane Doe" not in sent[0]
    rows = db.execute("SELECT day, metric, value FROM metric_values ORDER BY metric").fetchall()
    assert rows == [("2026-10-22", "review_count", 1234.0), ("2026-10-22", "review_score", 8.6)]


def test_cockpit_payload_has_numbers_and_health_but_no_text(tmp_path):
    db = _db(tmp_path)
    store.add_snapshot(db, run_id="20261022-163347", cid="booking", slug="reviews", captured_at="x", status="ok",
                       text_path="/secret/path.txt", detail="")
    store.put_metric(db, day="2026-10-22", cid="booking", metric="review_score", period="", label="评分", value=8.6,
                     unit="/10", benchmark=None, run_id="20261022-163347", source_slug="reviews", extracted_by="codex")
    body = cockpit.payload(db, "20261022-163347")
    assert body["run"]["id"] == "20261022-163347"
    assert body["pages"] == [{"platform": "booking", "page": "reviews", "status": "ok", "detail": ""}]
    assert body["metrics"][0]["value"] == 8.6
    assert "/secret/path.txt" not in str(body)
    assert isinstance(db, sqlite3.Connection)


def test_advice_must_cite_real_numbers():
    from ota import advise
    data = {"booking": {"conversion_rate@last_30_days": {"label": "转化率", "unit": "%", "points": [["2026-10-29", 2.1]]}}}
    assert advise.cites_data("Booking 转化率 2.1%（10-29）", data)
    assert not advise.cites_data("转化率掉到 1.7%", data)


def test_landing_sends_only_score_lines_not_reviewers():
    page = ("Reviews\nAll reviews\n4.8\n|\n315 reviews\n|\nFilters\nNo response\nirauaua\nToday\n"
            "Great Stay and Perfect Location\nI really enjoyed my stay at Wyndham Gardens! The hotel was lovely\n"
            "Camper08818121399\nRick Cotto\nOct 20, 2026\n5293222071\n")
    win = extract.landing_window(page)
    assert "4.8" in win and "315 reviews" in win
    assert not any(w in win for w in ("irauaua", "Camper", "Rick Cotto", "enjoyed", "Great Stay", "5293222071"))


def test_daily_report_cites_stored_numbers_and_keeps_its_day(tmp_path):
    from ota import advise
    db = _db(tmp_path)
    for day, v in (("2026-10-14", 2.9), ("2026-10-21", 2.7), ("2026-10-22", 2.56)):
        store.put_metric(db, day=day, cid="booking", metric="click_rate", period="funnel", label="搜索→点击率",
                         value=v, unit="%", benchmark=3.1, run_id=day.replace("-", "") + "-113000",
                         source_slug="search-rank", extracted_by="codex")
    ch = {c["metric"]: c for c in advise.changes(advise.history(db, days=10_000))}["click_rate@funnel"]
    assert ch["prev"]["day"] == "2026-10-21" and ch["d7"]["day"] == "2026-10-14"
    assert round(ch["vs_benchmark"], 2) == -0.54

    sent = []

    def ask(prompt, schema, timeout=0):
        sent.append(prompt)
        item = {"platform": "booking", "area": "conversion", "priority": "high", "owner": "市场/内容", "title": "t",
                "analysis": "a", "action": "x", "expected": "y"}
        return {"summary": "s", "watch": ["w"],
                "highlights": [{"platform": "booking", "tone": "bad", "text": "点击率 2.56%，同类 3.1%"},
                               {"platform": "booking", "tone": "bad", "text": "点击率暴跌到 1.7%"}],
                "items": [item | {"evidence": "点击率 2.56%（10-22），7 天前 2.9%"}, item | {"evidence": "大约一半"}]}

    body = advise.report(db, "2026-10-22", push=False, ask=ask)
    assert body["id"] == "2026-10-22"
    assert len(body["items"]) == 1 and len(body["highlights"]) == 1
    assert "2026-10-22" in sent[0]
