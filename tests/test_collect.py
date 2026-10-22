"""collect_platform against a fake browser: what gets read, what gets skipped, and that tabs close."""
import asyncio
from pathlib import Path

from ota import collect, config
from ota.platforms import BY_CID


class FakeResp:
    def __init__(self, status):
        self.status = status


class FakePage:
    def __init__(self, routes):
        self.routes, self.url, self.closed, self.visited = routes, "about:blank", False, []

    async def goto(self, url, **_):
        self.visited.append(url)
        target, status, text = self.routes(url)
        if isinstance(target, Exception):
            raise target
        self.url, self._text = target, text
        return FakeResp(status)

    async def wait_for_timeout(self, _):
        pass

    async def title(self):
        return "t"

    async def inner_text(self, _):
        return self._text

    async def evaluate(self, _):
        return [{"text": "Analytics", "href": "https://admin.booking.com/x"}]

    async def screenshot(self, path, **_):
        Path(path).write_bytes(b"png")

    async def close(self):
        self.closed = True


class FakeCtx:
    def __init__(self, routes):
        self.page = FakePage(routes)

    async def new_page(self):
        return self.page


def run(ctx, cid, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SETTLE_MS", 0)
    monkeypatch.setattr(config, "PAUSE_BETWEEN_PAGES_MS", 0)
    return asyncio.run(collect.collect_platform(ctx, BY_CID[cid], tmp_path))


def test_signed_out_landing_reads_nothing_else(tmp_path, monkeypatch):
    ctx = FakeCtx(lambda u: ("https://account.booking.com/sign-in", 200, "Sign in to manage your property"))
    rows = run(ctx, "booking", tmp_path, monkeypatch)
    assert [r["status"] for r in rows] == ["signed_out"]
    assert ctx.page.visited == ["https://admin.booking.com/"] and ctx.page.closed
    assert not list((tmp_path / "booking").iterdir())          # nothing saved from a sign-in page


def test_booking_pages_use_landing_session_and_survive_errors(tmp_path, monkeypatch):
    home = "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/home.html?hotel_id=9&ses=s1"

    def routes(u):
        if u == "https://admin.booking.com/":
            return home, 200, "Guest reviews"
        if "analytics" in u:
            return RuntimeError("net::ERR_TIMED_OUT"), 0, ""
        if "property_page_score" in u:
            return u, 404, "Not found"
        return u, 200, "Review score 8.6"

    ctx = FakeCtx(routes)
    rows = run(ctx, "booking", tmp_path, monkeypatch)
    assert {r["slug"]: r["status"] for r in rows} == {
        "landing": "ok", "reviews": "ok", "analytics": "error", "property-page-score": "page_missing", "inbox": "ok"}
    assert all("hotel_id=9&ses=s1" in u for u in ctx.page.visited[1:])
    assert (tmp_path / "booking" / "reviews.txt").read_text() == "Review score 8.6"
    assert ctx.page.closed


def test_tab_closes_even_when_landing_crashes(tmp_path, monkeypatch):
    ctx = FakeCtx(lambda u: (RuntimeError("boom"), 0, ""))
    try:
        run(ctx, "google", tmp_path, monkeypatch)
    except RuntimeError:
        pass
    assert ctx.page.closed
