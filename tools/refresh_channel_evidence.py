"""Bounded read-only refresh of verified channel pages; no model, no OTA mutations.

Run on the hotel collector host from the repo: .venv/bin/python tools/refresh_channel_evidence.py
Preserves the review lock/window guard. Raw evidence remains in private local snapshots;
only catalogue-validated numeric aggregates and page health are pushed to the cockpit.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ota import cockpit, collect, config, extract, guard, store  # noqa: E402
from ota.platforms import BY_CID, fill  # noqa: E402
from ota.readonly import ReadOnlyTab  # noqa: E402

SELECTED = {'booking': {'search-rank-30d'}, 'ctrip': {'traffic', 'performance', 'lost-bookings'},
            'agoda': {'dashboard', 'lost-bookings'}, 'expedia': {'data-insights'}}


async def read(db, run_id):
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(f'http://127.0.0.1:{config.CDP_PORT}')
        tab = ReadOnlyTab(await browser.contexts[0].new_page())
        try:
            for cid, slugs in SELECTED.items():
                out = collect._private_dir(config.DATA / 'snapshots' / run_id / cid)
                landing_url = None
                if cid == 'booking':
                    await tab.open(BY_CID[cid].landing, config.PAGE_TIMEOUT_MS, config.SETTLE_MS)
                    landing_url = tab.url
                for page in BY_CID[cid].pages:
                    if page.slug not in slugs:
                        continue
                    try:
                        url = fill(page.url, landing_url) if cid == 'booking' else page.url
                        if not url:
                            raise RuntimeError('missing_platform_session')
                        row = await collect._read_page(tab, url, out, page.slug, page.settle_ms, retry=False)
                    except Exception as exc:  # noqa: BLE001
                        row = {'slug': page.slug, 'url': page.url, 'status': 'error', 'detail': type(exc).__name__}
                    store.add_snapshot(db, run_id=run_id, cid=cid, captured_at=collect.now().isoformat(timespec='seconds'),
                                       **{k: row.get(k) for k in ('slug', 'url', 'http_status', 'title', 'status', 'detail',
                                                                 'text_path', 'shot_path', 'links_path')})
                    print(json.dumps({'platform': cid, 'page': page.slug, 'status': row['status']}), flush=True)
        finally:
            await tab.close()


def no_model(*args):
    raise RuntimeError('this refresh never calls a model')


def main():
    started = collect.now()
    near = guard.near_review_window(started, config.AVOID_SLOTS, config.AVOID_MARGIN_MIN)
    if near:
        print(json.dumps({'skipped': 'near_review_window', 'slot': near}))
        return 3
    try:
        fd = guard.take_operator_lock(config.OPERATOR_LOCK)
    except guard.Busy:
        print(json.dumps({'skipped': 'review_busy'}))
        return 3
    db = store.connect(config.DB)
    run_id = started.strftime('%Y%m%d-%H%M%S')
    store.start_run(db, run_id, started.isoformat(timespec='seconds'))
    try:
        asyncio.run(asyncio.wait_for(read(db, run_id), timeout=180))
    except Exception as exc:  # noqa: BLE001
        store.finish_run(db, run_id, collect.now().isoformat(timespec='seconds'), 'failed', {'error': type(exc).__name__})
        raise
    finally:
        guard.release(fd)
    counts = extract.extract_run(db, run_id, ask=no_model)
    store.finish_run(db, run_id, collect.now().isoformat(timespec='seconds'), 'done', {'channel_refresh': True, 'counts': counts})
    config.load_env()
    result = cockpit.post('/api/ingest', cockpit.payload(db, run_id))
    print(json.dumps({'run': run_id, 'pushed': result.get('ok'), 'counts': counts}), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
