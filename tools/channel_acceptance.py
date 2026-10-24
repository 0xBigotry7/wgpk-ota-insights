"""Local-only channel workbench acceptance; seeded real evidence, never OTA writes/model calls."""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8794'
OUT = Path('data/acceptance')
OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=True)
    page = browser.new_page(viewport={'width': 1512, 'height': 1100})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE + '/login')
    page.locator('input[name="password"]').fill('local-test')
    page.locator('button[type="submit"]').click()
    page.wait_for_selector('[data-channel="ctrip"]')
    assert page.locator('.channel-col').count() == 4
    assert page.locator('[data-channel="ctrip"] .stage-1 strong').inner_text() == '83,289'
    assert page.locator('[data-channel="ctrip"] .stage-2 strong').inner_text() == '41,283'
    assert page.locator('[data-channel="ctrip"] .stage-3 strong').inner_text() == '133'
    assert '近30天' in page.locator('[data-channel="ctrip"]').inner_text()
    assert '2026-10-23' in page.locator('[data-channel="ctrip"]').inner_text()
    assert page.locator('[data-channel="agoda"] .stage-2 strong').inner_text() == '—'
    assert '第 1 名' in page.locator('[data-channel="agoda"]').inner_text()
    assert page.locator('[data-channel="expedia"] .missing').count() == 3
    assert '14' in page.locator('#channel-signal-metrics').inner_text()
    assert '62' in page.locator('#channel-signal-metrics').inner_text()
    assert '140' in page.locator('[data-future-channel="ctrip"]').inner_text()
    assert '246.9' in page.locator('[data-future-channel="ctrip"]').inner_text()
    assert '1,777,728' not in page.locator('[data-future-channel="ctrip"]').inner_text()
    page.locator('#channel-horizon').select_option('90')
    assert page.locator('[data-future-channel="ctrip"] .forward-main strong').inner_text() == '—'
    page.locator('#channel-horizon').select_option('30')
    assert '140' in page.locator('[data-future-channel="ctrip"]').inner_text()
    page.locator('#sec-channels').screenshot(path=str(OUT / 'channel-funnels-desktop.png'))
    page.locator('#sec-channel-future').screenshot(path=str(OUT / 'channel-future-desktop.png'))
    for width in [360, 390, 800, 1100, 1180, 1512, 1920]:
        page.set_viewport_size({'width': width, 'height': 1100})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
    page.set_viewport_size({'width': 390, 'height': 844})
    page.locator('[data-channel="ctrip"]').screenshot(path=str(OUT / 'channel-funnel-mobile.png'))
    page.locator('#sec-channel-loss').screenshot(path=str(OUT / 'channel-issues-mobile.png'))
    # Reuse the existing cockpit-only investigation/audit path and freeze the source baseline.
    state = page.request.get(BASE + '/api/state').json()
    for decision in state['operator']['decisions']:
        if decision['source_ref'] == 'channel:ctrip:lost' and decision['status'] in ('investigating', 'reported'):
            page.request.post(BASE + '/api/operator/' + str(decision['id']), data={'status': 'dismissed', 'note': '结束前次本地验收'}, headers={'Origin': BASE})
    page.reload()
    page.wait_for_selector('[data-channel-approve="channel:ctrip:lost"]')
    page.locator('[data-channel-approve="channel:ctrip:lost"]').click()
    page.wait_for_selector('[data-channel-issue="channel:ctrip:lost"] a')
    after = page.request.get(BASE + '/api/state').json()
    decision = next(x for x in after['operator']['decisions'] if x['source_ref'] == 'channel:ctrip:lost' and x['status'] == 'investigating')
    assert decision['baseline']['value'] == 62
    assert decision['baseline']['period'] == 'last_14_days'
    assert not errors, errors
    print(json.dumps({'channels': 4, 'flows': ['native funnels', 'missing vs rank', 'source cutoff', 'lost/won signals', '30/90 OTB', 'no borrowed revenue', 'investigation freeze', 'responsive 360–1920'], 'errors': errors}))
    browser.close()
