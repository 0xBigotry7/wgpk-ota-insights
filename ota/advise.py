"""Daily OTA analysis and advice report, written from the stored numbers only and pushed to the cockpit.

Runs at the end of every daily collection (ota.run calls report() after the cockpit push), or by hand:

  python -m ota.advise [--day 2026-10-22] [--dry-run]

Every highlight and recommendation must cite numbers that exist in the data it was given; ones that cite
none are dropped. Advice only: nothing here changes a price, a promotion or a listing.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path

from . import cockpit, config, llm, store

PLATFORM_ENUM = ["booking", "agoda", "expedia", "ctrip", "google", "tripadvisor", "medallia", "all"]
AREAS = ["price", "traffic", "conversion", "reputation", "experience", "content", "data"]
OWNERS = ["收益/销售", "前台", "客房", "工程", "餐饮", "市场/内容", "总经理"]

SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["summary", "highlights", "items", "watch"],
    "properties": {
        "summary": {"type": "string"},
        "highlights": {"type": "array", "items": {
            "type": "object", "additionalProperties": False, "required": ["platform", "tone", "text"],
            "properties": {"platform": {"type": "string", "enum": PLATFORM_ENUM},
                           "tone": {"type": "string", "enum": ["good", "bad", "neutral"]},
                           "text": {"type": "string"}}}},
        "items": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["platform", "area", "priority", "owner", "title", "evidence", "analysis", "action", "expected"],
            "properties": {
                "platform": {"type": "string", "enum": PLATFORM_ENUM},
                "area": {"type": "string", "enum": AREAS},
                "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                "owner": {"type": "string", "enum": OWNERS},
                "title": {"type": "string"}, "evidence": {"type": "string"}, "analysis": {"type": "string"},
                "action": {"type": "string"}, "expected": {"type": "string"}}}},
        "watch": {"type": "array", "items": {"type": "string"}},
    },
}

PROMPT = """
必须区分事实、假设和建议；不能仅凭 ADR/间夜同类差异判断低价换量或建议固定涨降价幅度。未知库存、净佣金和可比价型时先调查；滚动窗口差值不是 pickup，勾选完成不代表已增收。
你是普吉岛卡马拉温德姆花园酒店（Wyndham Garden Phuket Kamala）的 OTA 运营顾问。不要运行任何工具，直接回答。
今天是 {day}。下面是各 OTA 后台每日只读采集到的指标。
- series：每个指标的历史，points 为 [日期, 数值, 平台对比值(可选)]；benchmark 是平台自己给的同类/品牌对比值。
- changes：程序算好的变化（较上次采集、较 7 天前、较平台对比值）。
- pages：今天每个页面的采集状态；不是 ok 的页面说明数据缺失。
数据覆盖 {days} 天。天数少时，主要和平台对比值、页面上的月度数据比；天数多了再看趋势。
普吉现在是{season}。

下面是 OTA 运营知识（各平台排名因素、项目门槛、症状→原因→动作、收益管理日常）。判断原因、给动作时按这些规则来，
在 analysis 里说清依据的是哪条规则；知识里标“第三方说法”或“以后台为准”的，写成“以后台为准”。
{knowledge}

请用中文写一份今天的 OTA 分析建议报告，写细：
- summary：2 到 3 句，今天最重要的判断。
- highlights：4 到 8 条今日要点，每条一句话，带具体数字；tone 标 good / bad / neutral。
- items：5 到 10 条建议，按优先级排列。每条：
  - area：price 价格 / traffic 流量曝光 / conversion 转化 / reputation 口碑评分 / experience 客人体验 / content 页面内容 / data 数据缺口；
  - owner：负责部门；
  - evidence：必须引用上面数据里真实存在的数字（带日期或时段），不能编造；
  - analysis：为什么会这样、说明了什么，2 到 3 句；
  - action：谁去哪个后台哪个页面做什么，具体到步骤；
  - expected：做完后看哪个指标、期望往哪个方向变。
- watch：明天要继续盯的 2 到 4 个指标，每条一句。
规则：只给建议；改价、报名促销、改房态由人决定，不要写成“系统将自动……”。价格和房态由 OPERA/SynXis 同步，
不要建议直接在 OTA 后台改价，而是建议收益经理在 OPERA/SynXis 调整。数据不支持的结论不要写，宁可少写。

数据：
{data}
"""


KNOWLEDGE_JS = Path(__file__).resolve().parent.parent / "cockpit" / "src" / "knowledge.js"


def knowledge() -> str:
    """The OTA playbook text shared with the cockpit copilot (single source: cockpit/src/knowledge.js)."""
    try:
        text = KNOWLEDGE_JS.read_text(encoding="utf-8")
    except OSError:
        return ""
    m = re.search(r"KNOWLEDGE = String\.raw`(.*?)`;", text, re.S)
    return m.group(1).strip() if m else ""


def season(day: str) -> str:
    month = int(day[5:7])
    if month == 10:
        return "旺季前爬坡期（11 月起进入旺季，1 月最高）"
    if month >= 11 or month <= 4:
        return "旺季"
    return "旺转淡" if month == 5 else "淡季（6–9 月）"


def history(db, days: int = 120) -> dict:
    since = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    out: dict = {}
    for day, cid, metric, period, label, value, unit, bench in db.execute(
            "SELECT day, cid, metric, period, label, value, unit, benchmark FROM metric_values WHERE day >= ? "
            "ORDER BY cid, metric, day", (since,)):
        # A 0 score is an unrendered tile and a 0 comparison a misread (rows stored before extract.check dropped them).
        if value == 0 and (unit or "").startswith("/"):
            continue
        bench = bench or None
        s = out.setdefault(cid, {}).setdefault(f"{metric}{'@' + period if period else ''}",
                                               {"label": label, "unit": unit, "points": []})
        s["points"].append([day, value] + ([bench] if bench is not None else []))
    return out


def changes(data: dict) -> list[dict]:
    """Latest value per series with its change vs the previous point, 7 days earlier and the benchmark."""
    out = []
    for cid, series in data.items():
        for key, s in series.items():
            pts = s["points"]
            day, value = pts[-1][0], pts[-1][1]
            row = {"platform": cid, "metric": key, "label": s["label"], "unit": s["unit"], "day": day, "value": value}
            if len(pts) > 1:
                row["prev"] = {"day": pts[-2][0], "value": pts[-2][1], "delta": round(value - pts[-2][1], 4)}
            cutoff = (dt.date.fromisoformat(day) - dt.timedelta(days=7)).isoformat()
            older = [p for p in pts if p[0] <= cutoff]
            if older:
                row["d7"] = {"day": older[-1][0], "value": older[-1][1], "delta": round(value - older[-1][1], 4)}
            if len(pts[-1]) > 2:
                row["benchmark"] = pts[-1][2]
                row["vs_benchmark"] = round(value - pts[-1][2], 4)
            out.append(row)
    return out


def page_health(db, day: str) -> list[dict]:
    rows = db.execute(
        "SELECT s.cid, s.slug, s.status, s.detail FROM snapshots s JOIN runs r ON r.id = s.run_id "
        "WHERE r.id = (SELECT id FROM runs WHERE id LIKE ? ORDER BY id DESC LIMIT 1)", (day.replace("-", "") + "%",))
    return [{"platform": c, "page": p, "status": st, "detail": (d or "")[:120]} for c, p, st, d in rows]


def cites_data(evidence: str, data) -> bool:
    nums = {round(float(x), 2) for x in re.findall(r"\d+(?:\.\d+)?", json.dumps(data))}
    return any(round(float(x.replace(",", "")), 2) in nums for x in re.findall(r"\d[\d,]*(?:\.\d+)?", evidence))


def build(db, day: str, ask=llm.ask_json) -> dict | None:
    data = history(db)
    days = len({p[0] for series in data.values() for s in series.values() for p in s["points"]})
    if not days:
        return None
    facts = {"series": data, "changes": changes(data), "pages": page_health(db, day)}
    res = ask(PROMPT.format(day=day, days=days, season=season(day), knowledge=knowledge(),
                            data=json.dumps(facts, ensure_ascii=False)), SCHEMA, timeout=420)
    items = [it for it in res.get("items", []) if cites_data(it.get("evidence", ""), facts)][:10]
    highlights = [h for h in res.get("highlights", []) if cites_data(h.get("text", ""), facts)][:8]
    return {"id": day, "generated_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            "summary": res.get("summary", ""), "highlights": highlights, "items": items,
            "watch": [w for w in res.get("watch", []) if w][:4], "model": "codex(chatgpt)"}


def report(db, day: str, push: bool = True, ask=llm.ask_json) -> dict | None:
    body = build(db, day, ask)
    if body and push:
        cockpit.post("/api/advice", body)
    return body


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", default=dt.datetime.now(dt.timezone(dt.timedelta(hours=7))).date().isoformat())
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    config.load_env()
    body = report(store.connect(config.DB), a.day, push=not a.dry_run)
    if body is None:
        print("skipped: no metrics yet", flush=True)
        return 3
    print(json.dumps(body, ensure_ascii=False, indent=1), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
