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


def test_drops_zero_scores_and_zero_benchmarks():
    # Agoda's score tile had not rendered (value 0); Expedia's comp-set cell read as 0.
    kept = extract.check([
        {"key": "review_score", "value": 0, "benchmark": None, "quote": "0"},
        {"key": "review_count", "value": 258, "benchmark": 0, "quote": "258"},
    ], M, "0 reviews 258")
    assert [(m.key, v, b) for m, v, b in kept] == [("review_count", 258.0, None)]


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


def test_native_channel_source_date_survives_extraction_and_aggregate_payload_without_model(tmp_path):
    db = _db(tmp_path)
    page = tmp_path / 'traffic.txt'
    page.write_text('列表页浏览量\n1,234\n详情页浏览量\n123\n订单量\n7\nSelected date filters: 2026-09-23 | 2026-10-22')
    store.add_snapshot(db, run_id='20261022-163347', cid='ctrip', slug='traffic', captured_at='x', status='ok', text_path=str(page))

    def no_model(*args):
        raise AssertionError('native metrics must not call a model')

    extract.extract_run(db, '20261022-163347', ask=no_model)
    payload = cockpit.payload(db, '20261022-163347')
    assert len(payload['metrics']) == 3
    assert all(m['source_as_of'] == '2026-10-22' for m in payload['metrics'])
    assert all(m['source_date_basis'] == 'selected_window_end' for m in payload['metrics'])
    assert all(m['period'] == 'dates_2026-09-23_2026-10-22' for m in payload['metrics'])
    assert 'Selected date filters' not in str(payload)


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
    assert "Visibility Booster" in sent[0] and "旺季前爬坡期" in sent[0]  # playbook and season are in the prompt


def test_report_ignores_zero_scores_and_zero_benchmarks(tmp_path):
    from ota import advise
    db = _db(tmp_path)
    store.put_metric(db, day="2026-10-23", cid="agoda", metric="review_score", period="", label="评分", value=0,
                     unit="/10", benchmark=None, run_id="20261023-102000", source_slug="landing", extracted_by="codex")
    store.put_metric(db, day="2026-10-23", cid="expedia", metric="lowest_rate_next_28d", period="next_28_days",
                     label="最低价", value=113, unit="USD", benchmark=0, run_id="20261023-102000", source_slug="data-insights",
                     extracted_by="codex")
    data = advise.history(db, days=10_000)
    assert "agoda" not in data
    assert data["expedia"]["lowest_rate_next_28d@next_28_days"]["points"] == [["2026-10-23", 113]]
    assert advise.knowledge().startswith("# 酒店基本盘")


def test_fallback_slot_sees_the_days_done_run(tmp_path):
    db = _db(tmp_path)
    store.start_run(db, "20261023-102000", "x")
    assert store.done_run_on(db, "20261023") is None
    store.finish_run(db, "20261023-102000", "y", "done", {})
    assert store.done_run_on(db, "20261023") == "20261023-102000"
    assert store.done_run_on(db, "20261024") is None


def test_landing_window_keeps_score_with_verdict_word():
    page = "Guest reviews\nWyndham Garden Phuket Kamala\n8.7 Excellent\nBased on 258 reviews\nNoel, Thailand\n"
    win = extract.landing_window(page)
    assert "8.7 Excellent" in win and "Noel" not in win


def test_implausible_values_are_dropped():
    metrics = {"review_score": Metric("review_score", "评分", "/10"), "share": Metric("share", "占比", "%"),
               "views_vs_peer": Metric("views_vs_peer", "较同类", "%")}
    text = "score 87 share 120.5 views +136.9"
    kept = extract.check([{"key": "review_score", "value": 87, "benchmark": None, "quote": ""},
                          {"key": "share", "value": 120.5, "benchmark": None, "quote": ""},
                          {"key": "views_vs_peer", "value": 136.9, "benchmark": None, "quote": ""}], metrics, text)
    assert [(mt.key, v) for mt, v, _ in kept] == [("views_vs_peer", 136.9)]


def test_one_metric_key_stores_every_stay_month(tmp_path):
    from tests.test_channel_extract import PACE
    db = _db(tmp_path)
    page = tmp_path / 'pace.txt'
    page.write_text(PACE)
    store.add_snapshot(db, run_id='20261028-102001', cid='booking', slug='pace-90d', captured_at='x', status='ok',
                       text_path=str(page))

    def no_model(*args):
        raise AssertionError('pace pages are parsed, not sent to a model')

    extract.extract_run(db, '20261028-102001', ask=no_model)
    rows = db.execute("SELECT period, value, benchmark FROM metric_values WHERE metric='pickup_90d_room_nights' "
                      "ORDER BY period").fetchall()
    assert rows == [('stay_2026-11', 120.0, 100.0), ('stay_2026-12', 1250.0, 900.0)]
