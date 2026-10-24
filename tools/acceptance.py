"""Local-only browser acceptance. Requires a seeded wrangler dev on localhost:8794.
Never runs against production and never calls a model or an OTA site.
"""
import json
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8794"
OUT = Path("data/acceptance")
OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless=True)
    page = browser.new_page(viewport={"width": 1512, "height": 1100}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.goto(BASE + "/login")
    page.locator('input[name="password"]').fill("local-test")
    page.locator('button[type="submit"]').click()
    page.wait_for_selector(".cal-day")
    initial = page.request.get(BASE + "/api/state").json()
    # Multi-metric default, adjacent calendar months (not next data-bearing month),
    # selection survives rerender and both months share the same source and bands.
    page.locator('#revenue-month').select_option('2026-10')
    assert page.locator('#revenue-metric').input_value() == 'all'
    assert page.locator('.calendar-month').count() == 2
    assert page.locator('.calendar-month h3').all_text_contents() == ['2026-10', '2026-11']
    cell = page.locator('[data-stay="2026-10-01"]')
    assert cell.locator('.cal-amount').count() == 2
    assert 'ADR' in cell.inner_text() and 'RevPAR' in cell.inner_text()
    assert '待确认' in page.locator('#revenue-calendar-note').inner_text()
    assert page.locator('[data-stay="2026-11-01"]').is_disabled()
    page.locator('#revenue-month').select_option('2026-09')
    page.locator('[data-stay="2026-10-01"]').click()
    assert '2026-10-01' in page.locator('#revenue-day').inner_text()
    page.locator('#revenue-metric').select_option('occupancy')
    assert page.locator('[data-stay="2026-10-01"]').get_attribute('aria-pressed') == 'true'
    page.locator('#revenue-view').select_option('single')
    assert page.locator('.calendar-month').count() == 1
    page.locator('#revenue-view').select_option('double')
    rollover = json.loads(json.dumps(initial))
    rollover['revenue']['days'].append({**rollover['revenue']['days'][0], 'stay_date': '2026-12-01'})
    page.evaluate("s => window.OperatorUI.render(s, () => {}, () => {})", rollover)
    page.locator('#revenue-month').select_option('2026-12')
    assert page.locator('.calendar-month h3').all_text_contents() == ['2026-12', '2027-01']
    assert page.locator('[data-stay="2027-01-01"]').is_disabled()
    assert '暂无报表数据' in page.locator('.calendar-month').last.inner_text()
    page.evaluate("s => window.OperatorUI.render(s, () => {}, () => {})", initial)
    page.reload()
    page.wait_for_selector('.cal-day')
    page.locator('#revenue-month').select_option('2026-10')
    page.locator('#revenue-metric').select_option('all')
    page.locator('[data-stay="2026-10-01"]').click()
    page.locator('#sec-revenue').scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / 'calendar-dual-metrics.png'))
    # Phone keeps one month, occupancy + ADR, with RevPAR available in details.
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_function("document.querySelectorAll('.calendar-month').length === 1")
    assert page.locator('[data-stay="2026-10-01"] .cal-revpar').is_hidden()
    assert page.locator('[data-stay="2026-10-01"] .cal-amount').first.is_visible()
    assert 'RevPAR' in page.locator('#revenue-day').inner_text()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.locator('#sec-revenue').scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / 'calendar-mobile-metrics.png'))
    for width in [360, 800, 1180, 1399, 1400, 1920]:
        page.set_viewport_size({"width": width, "height": 1100})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), width
        page.wait_for_function("count => document.querySelectorAll('.calendar-month').length === count", arg=2 if width >= 1400 else 1)
    page.set_viewport_size({"width": 1512, "height": 1100})
    for d in initial.get("operator", {}).get("decisions", []):
        if d["source_ref"] == "gate:pms" and d["status"] in ("investigating", "reported"):
            page.request.post(BASE + "/api/operator/" + str(d["id"]), data={"status": "dismissed", "note": "结束上轮本地验收记录"}, headers={"Origin": BASE})
    page.reload()
    page.wait_for_selector(".cal-day")
    assert "历史档案" in page.locator("#revenue-source").inner_text()
    assert "2026-07-28" in page.locator("#revenue-source").inner_text()
    assert page.locator(".op-card").count() >= 2
    page.locator('#revenue-month').select_option('2026-10')
    page.locator('#revenue-metric').select_option('occupancy')
    low = page.locator('[data-stay="2026-10-01"]').evaluate("e=>getComputedStyle(e).backgroundColor")
    high = page.locator('[data-stay="2026-10-02"]').evaluate("e=>getComputedStyle(e).backgroundColor")
    assert low != high, '9.8% and 10.6% must use visibly different fixed bands'
    assert page.locator('.occupancy-legend i').count() == 12
    page.locator('#sec-revenue').scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / 'occupancy-colors.png'))
    page.locator("#revenue-month").select_option("2026-07")
    page.locator('[data-stay="2026-07-27"]').click()
    assert "实绩" in page.locator("#revenue-day").inner_text()
    if any(d.get('operations') for d in initial['revenue']['days']):
        assert page.locator('.opera-operating').count() == 1
        assert '有效库存入住率' in page.locator('#revenue-day').inner_text()
        assert '散客扣库房量' in page.locator('#revenue-day').inner_text()
        assert '未扣库散客／团体房量' in page.locator('#revenue-day').inner_text()
        assert '不一致' not in page.locator('.opera-operating').inner_text()
        page.locator('#revenue-detail').evaluate('e=>e.open=true')
        page.locator('.opera-operating').screenshot(path=str(OUT / 'opera-operating-desktop.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.locator('.opera-operating').screenshot(path=str(OUT / 'opera-operating-mobile.png'))
        page.set_viewport_size({'width': 1512, 'height': 1100})
    page.locator("#scenario-use").click()
    page.locator("#sc-rate").fill("10")
    page.locator("#sc-change").fill("-5")
    page.locator("#sc-commission").fill("15")
    page.locator('#scenario-form button[type="submit"]').click()
    page.wait_for_function("document.querySelector('#scenario-result').textContent.includes('不代表利润')")
    assert "不是需求预测" in page.locator("#scenario-result").inner_text()
    page.locator("#revenue-month").select_option("2026-10")
    page.locator("#revenue-metric").select_option("revpar")
    page.locator('[data-stay="2026-10-23"]').click()
    assert "也不能变成实绩" in page.locator("#revenue-day").inner_text()
    page.locator(".op-approve").first.click()
    page.wait_for_selector('[data-status="reported"]')
    page.locator("[data-note]").first.fill("验收：人工检查经营报告的来源时间")
    page.locator('[data-status="reported"]').first.click()
    page.wait_for_selector('[data-status="reviewed"]')
    assert "人工报告已执行" in page.locator("#operator-decisions").inner_text()
    # Stale PMS cannot be marked verified: server-side gate, not just disabled UI.
    page.locator("[data-note]").first.fill("验收：尝试错误宣告经营报表恢复")
    page.locator('[data-status="reviewed"]').first.click()
    page.wait_for_function("document.querySelector('.toast').textContent.includes('仍未恢复')")
    assert "已人工复查" not in page.locator("#operator-decisions").inner_text()
    # Category filters must preserve the original alert index used to create a todo.
    assert initial['harness_version'] == '3.1-operator-foundations'
    assert all('data_context' in m for m in initial['metrics'])
    for group in initial['monitor']['inbox']['groups']:
        page.locator('[data-alert-category="' + group['id'] + '"]').click()
        indices = page.locator('[data-todo-alert]').evaluate_all("els=>els.map(e=>Number(e.dataset.todoAlert))")
        assert len(indices) == group['count']
        assert all(initial['monitor']['alerts'][i]['category'] == group['id'] for i in indices)
    page.locator('[data-alert-category="all"]').click()
    page.locator('#revenue-metric').select_option('occupancy')
    assert '固定入住率色阶' in page.locator('#revenue-legend').inner_text()
    assert page.locator('.cal-day[class*="occ-"]').count() > 0
    page.locator('#revenue-metric').select_option('adr')
    assert '不使用未经确认' in page.locator('#revenue-legend').inner_text()
    assert page.locator('.cal-day[class*="occ-"]').count() == 0
    assert '口径待核实' in page.locator('#revenue-day').inner_text()
    assert '入住日' in page.locator('#cop-context').inner_text()
    page.locator("#sec-revenue").scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / "desktop.png"))
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.set_viewport_size({"width": 390, "height": 844})
    page.locator("#sec-revenue").scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / "mobile.png"))
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "mobile horizontal overflow"
    page.locator("#fab").click()
    assert "open" in page.locator("#cop").get_attribute("class")
    page.locator("#cop-close").click()
    assert not errors, errors
    print(json.dumps({"local_browser": "passed", "desktop": "1512x1100", "mobile": "390x844", "page_errors": errors,
                      "flows": ["login", "source freshness", "calendar month/metric", "actual vs projection", "what-if", "approve", "report action", "reject unverified closure", "responsive", "inbox category / original index", "fixed bands / neutral ADR", "date contracts"]}))
    browser.close()
