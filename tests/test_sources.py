"""Agent-added data sources: what the collector will and will not read, and what it sends back."""
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
