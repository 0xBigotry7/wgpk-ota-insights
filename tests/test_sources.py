"""Agent-added data sources: what the collector will and will not read, and what it sends back."""
import sqlite3

import pytest

from ota import sources


@pytest.mark.parametrize("platform,url", [
    ("booking", "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/statistics/booker_insights.html?hotel_id=1&ses=x"),
    ("agoda", "https://portal.agoda.com/mldc/en-us/app/reporting/analyticscenter/1?analyticsTab=ContentScore"),
    ("ctrip", "https://ebooking.ctrip.com/ebkgrowth/datacenter/mix/overview"),
])
def test_analysis_pages_allowed(platform, url):
    assert sources.check_url(platform, url) is None


@pytest.mark.parametrize("platform,url,why", [
    ("booking", "http://admin.booking.com/x", "https"),
    ("booking", "https://evil.example.com/statistics", "not a known"),
    ("agoda", "https://admin.booking.com/statistics", "belongs to booking"),
    ("booking", "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/messaging/inbox.html", "messag"),
    ("agoda", "https://portal.agoda.com/mldc/en-us/app/hermes/inbox/ycs/1", "hermes"),
    ("booking", "https://admin.booking.com/manage/reviews/reply.html", "reply"),
    ("expedia", "https://apps.expediapartnercentral.com/lodging/payments/payout.html", "pay"),
    ("booking", "https://admin.booking.com/manage/rates/update.html", "update"),
    ("booking", "https://admin.booking.com/logout", "logout"),
])
def test_actions_and_private_pages_refused(platform, url, why):
    assert why in (sources.check_url(platform, url) or "")


def test_booking_session_becomes_placeholders():
    t = sources.template("https://admin.booking.com/x/stat.html?hotel_id=9&lang=en&ses=SECRET&period=DAYS90&t=1")
    assert "SECRET" not in t and "{ses}" in t and "{hotel_id}" in t and "period=DAYS90" in t
    assert "ses=REDACTED" in sources.redact("https://a/?x=1&ses=SECRET&y=2")


def test_guest_lists_rejected_and_identifiers_masked():
    assert sources.sanitize("Guest name: A\nReservation number 12345678\nGuest name: B")[0] is None
    text, _ = sources.sanitize("Room nights 120\ncontact a.b@x.com +66 81 234 5678 booking 123456789\nADR 5,000")
    assert "a.b@x.com" not in text and "234 5678" not in text and "123456789" not in text
    assert "Room nights 120" in text and "5,000" in text


def test_catalog_keys_validated_and_active_capped():
    src = {"id": 3, "status": "active", "platform": "booking",
           "url": "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/statistics/x.html",
           "catalog": [{"key": "cancel_rate", "label": "取消率", "unit": "%"}, {"key": "Bad Key"}, {"key": "x;drop"}]}
    assert [m.key for m in sources.metrics_of(src)] == ["cancel_rate"]
    many = [src | {"id": i} for i in range(20)]
    assert len(sources.active(many)) == sources.MAX_ACTIVE
    assert sources.active([src | {"catalog": []}]) == []
    assert sources.probe_candidates([src | {"status": "approved"}, src | {"status": "proposed"}]) == [src | {"status": "approved"}]


def test_probe_cap_counts_today_only(tmp_path):
    import sqlite3
    db = sqlite3.connect(tmp_path / "x.sqlite")
    sources.record_probe(db, "2026-10-28T20:00:00", 1, "ok")
    sources.record_probe(db, "2026-10-29T12:35:00", 2, "ok")
    assert sources.probes_today(db, "2026-10-29") == 1


def test_fixed_collector_pages_are_duplicates():
    base = "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/statistics"
    assert sources.fixed_page("booking", f"{base}/booker_insights.html?hotel_id=13267658&lang=en") == "booking/booker-insights"
    assert sources.fixed_page("booking", f"{base}/booker_insights.html?ses=abc&hotel_id=1") == "booking/booker-insights"
    assert sources.fixed_page("agoda", f"{base}/booker_insights.html?hotel_id=1") is None
    assert sources.fixed_page("booking", f"{base}/some_new_report.html?hotel_id=1") is None


def test_duplicates_do_not_count_toward_the_probe_cap(tmp_path):
    db = sqlite3.connect(tmp_path / "p.db")
    sources.record_probe(db, "2026-10-29T12:35:00", 7, "duplicate")
    assert sources.probes_today(db, "2026-10-29") == 0


def test_cockpit_url_rules_apply_here_too():
    base = "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage"
    assert sources.check_url("booking", f"{base}/statistics/cancellations.html") is None      # a word, not the verb
    assert sources.check_url("booking", f"{base}/cancel.html")                                # the verb
    assert sources.check_url("booking", f"{base}/guest_reviews.html")                         # guest conversations
    assert sources.check_url("booking", f"{base}/x.html#/messages")                           # hash routes too


def test_session_parameters_and_anchors_are_stripped():
    url = sources.strip_session("https://admin.booking.com/a/b.html?hotel_id=1&lang=en&ses=abc&period=DAYS30&authKey=z#main")
    assert url == "https://admin.booking.com/a/b.html?period=DAYS30"
    assert sources.strip_session("https://ycs.agoda.com/x?token=1#/analytics/pace").endswith("/x#/analytics/pace")


def test_link_catalog_from_pages_already_read(tmp_path):
    import json
    db = sqlite3.connect(tmp_path / "s.db")
    db.execute("CREATE TABLE snapshots (run_id TEXT, cid TEXT, slug TEXT, links_path TEXT)")
    base = "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage"
    links = [{"text": "Booker insights", "href": f"{base}/statistics/booker_insights.html?hotel_id=1&ses=s1"},
             {"text": "Booker insights", "href": f"{base}/statistics/booker_insights.html?hotel_id=1&ses=s2"},
             {"text": "Market insights", "href": f"{base}/market_insights.html?hotel_id=1&ses=s1"},
             {"text": "Reply", "href": f"{base}/reviews/reply.html?ses=s1"},
             {"text": "Inbox", "href": f"{base}/messaging/inbox.html?ses=s1"},
             {"text": "Elsewhere", "href": "https://example.com/stats"},
             {"text": "Jane Doe 5124721786 Superior", "href": f"{base}/booking.html?res_id=5124721786&ses=s1"},
             {"text": "Sales report", "href": f"{base}/statistics/sales_insights.html?reservationType=BOOKED&ses=s1"},
             {"text": "Export", "href": f"{base}/statistics/export/api/v1/rates?ses=s1"},
             {"text": "Late deal", "href": f"{base}/promotions/setup.html?product=X&ses=s1"},
             {"text": "Skip to main content", "href": f"{base}/statistics/demand_data.html?ses=s1"}]
    lp = tmp_path / "genius.links.json"
    lp.write_text(json.dumps(links + [{"text": f"p{i}", "href": f"{base}/statistics/p{i}.html"} for i in range(300)]))
    mp = tmp_path / "medallia.links.json"
    mp.write_text(json.dumps([{"text": "Post Stay Survey", "href": "https://wyndhamhotels.medallia.com/sso/x/pages/249?r=1"}]))
    db.execute("INSERT INTO snapshots VALUES ('r', 'booking', 'genius', ?)", (str(lp),))
    db.execute("INSERT INTO snapshots VALUES ('r', 'medallia', 'home', ?)", (str(mp),))
    [page] = sources.link_catalog(db, "r")                              # Medallia left out entirely
    assert page["slug"] == "booking/links"
    lines = page["sample_text"].splitlines()
    assert len(lines) == sources.MAX_LINKS
    assert lines[0] == f"Booker insights\t{base}/statistics/booker_insights.html\t[已每天采集: booking/booker-insights]"
    assert lines[1] == f"Market insights\t{base}/market_insights.html"
    assert "sales_insights.html?reservationType" not in "\n".join(lines)     # conservative: "reservation" anywhere drops it
    text = page["sample_text"]
    for leak in ("ses=", "reply", "inbox", "Jane", "5124721786", "res_id", "export", "promotions"):
        assert leak not in text, leak
    assert f"demand_data.html\t{base}/statistics/demand_data.html" in text      # generic label replaced by the page name
