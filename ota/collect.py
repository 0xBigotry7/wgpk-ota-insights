"""One read-only pass over every OTA dashboard.

Attaches to the review operator's Chrome over CDP (never launches or quits it), opens its own new
tabs, reads each configured page and closes the tabs. A platform that is signed out is recorded and
skipped: this program never signs in, never fills a field and never clicks.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
from pathlib import Path

from . import config, store
from .platforms import PLATFORMS, Platform, fill, page_problem, signed_out
from .readonly import ReadOnlyTab

BKK = dt.timezone(dt.timedelta(hours=7))


def now() -> dt.datetime:
    return dt.datetime.now(BKK)


def _private_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True, mode=0o700)
    return p


async def _read_page(tab: ReadOnlyTab, url: str, out: Path, slug: str, settle_ms: int = 0,
                     retry: bool = True) -> dict:
    status = await tab.open(url, config.PAGE_TIMEOUT_MS, config.SETTLE_MS + settle_ms)
    text = await tab.text()
    row = {"slug": slug, "url": tab.url, "http_status": status, "title": await tab.title()}
    why = signed_out(tab.url, text)
    if why:
        return row | {"status": "signed_out", "detail": why}
    if status and status >= 400:
        return row | {"status": "page_missing", "detail": f"HTTP {status}"}
    problem = page_problem(url, tab.url, text) if slug != "landing" else None
    if problem and problem[0] == "error" and retry:
        await tab.pause(config.RETRY_WAIT_MS)          # slow widgets: wait once more, then read again
        text = await tab.text()
        problem = page_problem(url, tab.url, text)
    if problem and problem[0] == "page_missing":
        return row | {"status": "page_missing", "detail": problem[1]}
    (out / f"{slug}.txt").write_text(text)
    (out / f"{slug}.links.json").write_text(json.dumps(await tab.links(), ensure_ascii=False, indent=1))
    await tab.screenshot(out / f"{slug}.png")
    for f in (f"{slug}.txt", f"{slug}.links.json", f"{slug}.png"):
        os.chmod(out / f, 0o600)
    # Kept on disk for a look by hand, but "error" pages are not read for numbers.
    status_detail = {"status": problem[0], "detail": problem[1]} if problem else {"status": "ok", "detail": ""}
    return row | status_detail | {"text_path": str(out / f"{slug}.txt"),
                  "shot_path": str(out / f"{slug}.png"), "links_path": str(out / f"{slug}.links.json")}


async def collect_platform(ctx, p: Platform, run_dir: Path) -> list[dict]:
    out = _private_dir(run_dir / p.cid)
    tab = ReadOnlyTab(await ctx.new_page())
    rows: list[dict] = []
    try:
        landing = await _read_page(tab, p.landing, out, "landing")
        rows.append(landing)
        if landing["status"] == "signed_out":
            return rows                       # the review operator owns sign-in; we only note it
        landing_url = landing["url"]
        # A signed-out sub-page is that page's status only: some report apps (Expedia's legacy
        # /lodging/ pages) want their own login while the landing session is fine.
        for page in p.pages:
            url = fill(page.url, landing_url)
            if url is None:
                rows.append({"slug": page.slug, "url": page.url, "status": "page_missing",
                             "detail": "landing URL had no value for the page's placeholders"})
                continue
            await tab.pause(config.PAUSE_BETWEEN_PAGES_MS)
            try:
                rows.append(await _read_page(tab, url, out, page.slug, page.settle_ms, page.retry))
            except Exception as e:  # noqa: BLE001 - one page never stops the platform
                rows.append({"slug": page.slug, "url": url, "status": "error", "detail": f"{type(e).__name__}: {e}"[:300]})
    finally:
        await tab.close()
    return rows


async def collect(only: set[str] | None, run_id: str, db) -> dict:
    from playwright.async_api import async_playwright  # imported here so tests run without a browser

    run_dir = _private_dir(config.DATA / "snapshots" / run_id)
    summary: dict[str, dict] = {}
    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(f"http://127.0.0.1:{config.CDP_PORT}")
        ctx = browser.contexts[0]
        for p in PLATFORMS:
            if only and p.cid not in only:
                continue
            try:
                rows = await collect_platform(ctx, p, run_dir)
            except Exception as e:  # noqa: BLE001 - one platform never stops the run
                rows = [{"slug": "landing", "url": p.landing, "status": "error",
                         "detail": f"{type(e).__name__}: {e}"[:300]}]
            for r in rows:
                store.add_snapshot(db, run_id=run_id, cid=p.cid, captured_at=now().isoformat(timespec="seconds"),
                                   **{k: r.get(k) for k in ("slug", "url", "http_status", "title", "status", "detail",
                                                            "text_path", "shot_path", "links_path")})
            summary[p.cid] = {r["slug"]: r["status"] for r in rows}
        # Detach only. Closing the CDP connection must not close the operator's Chrome.
    return summary


def run_with_deadline(only: set[str] | None, run_id: str, db) -> dict:
    return asyncio.run(asyncio.wait_for(collect(only, run_id, db), timeout=config.RUN_DEADLINE_S))
