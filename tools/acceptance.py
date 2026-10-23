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
    for d in initial.get("operator", {}).get("decisions", []):
        if d["source_ref"] == "gate:pms" and d["status"] in ("investigating", "reported"):
            page.request.post(BASE + "/api/operator/" + str(d["id"]), data={"status": "dismissed", "note": "结束上轮本地验收记录"}, headers={"Origin": BASE})
    page.reload()
    page.wait_for_selector(".cal-day")
    assert "历史档案" in page.locator("#revenue-source").inner_text()
    assert "2026-07-28" in page.locator("#revenue-source").inner_text()
    assert page.locator(".op-card").count() >= 2
    page.locator("#revenue-month").select_option("2026-07")
    page.locator('[data-stay="2026-07-27"]').click()
    assert "实绩" in page.locator("#revenue-day").inner_text()
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
                      "flows": ["login", "source freshness", "calendar month/metric", "actual vs projection", "what-if", "approve", "report action", "reject unverified closure", "responsive"]}))
    browser.close()
