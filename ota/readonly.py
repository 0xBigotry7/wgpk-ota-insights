"""The only thing collectors get to touch: a read-only browser tab.

ReadOnlyTab wraps one Playwright page that *we* opened in the review operator's Chrome. It exposes
navigation by URL, reading text, the page's link list, a screenshot and close. Nothing else: no
click, fill, type, keyboard, mouse or arbitrary script. tests/test_readonly.py checks the source of
every collector module for those calls, so adding one fails CI rather than review.
"""
from __future__ import annotations

from pathlib import Path

# Fixed, side-effect-free: the visible links on the page, for calibrating UNVERIFIED page URLs.
LINKS_JS = """() => Array.from(document.querySelectorAll('a[href]')).slice(0, 400)
  .map(a => ({text: (a.innerText || '').trim().slice(0, 80), href: a.href}))
  .filter(l => l.text && l.href.startsWith('http'))"""


class ReadOnlyTab:
    def __init__(self, page) -> None:
        self._page = page

    async def open(self, url: str, timeout_ms: int, settle_ms: int) -> int | None:
        resp = await self._page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        await self._page.wait_for_timeout(settle_ms)
        return resp.status if resp else None

    @property
    def url(self) -> str:
        return self._page.url

    async def title(self) -> str:
        return await self._page.title()

    async def text(self) -> str:
        return await self._page.inner_text("body")

    async def links(self) -> list[dict]:
        return await self._page.evaluate(LINKS_JS)

    async def screenshot(self, path: Path) -> None:
        await self._page.screenshot(path=str(path), full_page=True)

    async def pause(self, ms: int) -> None:
        await self._page.wait_for_timeout(ms)

    async def close(self) -> None:
        await self._page.close()
