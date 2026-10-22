"""Weekly OTA operations advice, written from the stored numbers only and pushed to the cockpit.

  python -m ota.advise            # what launchd runs on Monday 08:00
  python -m ota.advise --dry-run  # print the advice, do not push

Every item must cite numbers that exist in the data it was given; items that cite none are dropped.
Advice only: nothing here changes a price, a promotion or a listing.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys

from . import cockpit, config, llm, store

MIN_DAYS = 3
SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["summary", "items"],
    "properties": {
        "summary": {"type": "string"},
        "items": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["platform", "priority", "title", "evidence", "action"],
            "properties": {
                "platform": {"type": "string", "enum": ["booking", "agoda", "expedia", "ctrip", "google", "tripadvisor",
                                                        "medallia", "all"]},
                "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                "title": {"type": "string"}, "evidence": {"type": "string"}, "action": {"type": "string"}}}},
    },
}

PROMPT = """你是普吉岛卡马拉温德姆花园酒店（Wyndham Garden Phuket Kamala）的 OTA 运营顾问。不要运行任何工具，直接回答。
下面是各 OTA 后台每日采集到的指标（JSON，按平台和日期）。数据覆盖 {days} 天。

请用中文写本周的 OTA 运营建议：
- summary：一句话总结本周最重要的变化。
- items：3 到 5 条建议，按优先级排列。每条：
  - evidence 必须引用下面数据里真实存在的数字和日期（例如 "Booking 转化率 2.1%（10-29），7 天前 2.6%"），不能编造；
  - action 写清楚谁去哪个后台做什么，具体到页面；
  - 只给建议。改价、报名促销、改房态由人决定，不要写成“系统将自动……”。
- 数据不足以支持判断时就少写几条，不要凑数。价格和房态由 OPERA/SynXis 同步，不建议在 OTA 后台直接改价。

数据：
{data}
"""


def history(db, days: int = 56) -> dict:
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    out: dict = {}
    for day, cid, metric, period, label, value, unit, bench in db.execute(
            "SELECT day, cid, metric, period, label, value, unit, benchmark FROM metric_values WHERE day >= ? "
            "ORDER BY cid, metric, day", (since,)):
        s = out.setdefault(cid, {}).setdefault(f"{metric}{'@' + period if period else ''}",
                                               {"label": label, "unit": unit, "points": []})
        s["points"].append([day, value] + ([bench] if bench is not None else []))
    return out


def cites_data(evidence: str, data: dict) -> bool:
    nums = {round(float(x), 2) for x in re.findall(r"\d+(?:\.\d+)?", json.dumps(data))}
    return any(round(float(x.replace(",", "")), 2) in nums for x in re.findall(r"\d[\d,]*(?:\.\d+)?", evidence))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    config.load_env()
    db = store.connect(config.DB)
    data = history(db)
    days = len({p[0] for series in data.values() for s in series.values() for p in s["points"]})
    if days < MIN_DAYS:
        print(f"skipped: only {days} day(s) of data; need {MIN_DAYS}", flush=True)
        return 3
    res = llm.ask_json(PROMPT.format(days=days, data=json.dumps(data, ensure_ascii=False)), SCHEMA)
    items = [it for it in res.get("items", []) if cites_data(it.get("evidence", ""), data)][:6]
    year, week, _ = dt.date.today().isocalendar()
    body = {"id": f"{year}-W{week:02d}", "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            "summary": res.get("summary", ""), "items": items, "model": "codex(chatgpt)"}
    print(json.dumps(body, ensure_ascii=False, indent=1), flush=True)
    if not a.dry_run:
        print(json.dumps(cockpit.post("/api/advice", body)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
