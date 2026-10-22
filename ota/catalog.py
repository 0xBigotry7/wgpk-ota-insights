"""Which numbers to read off which page. Keys are stable forever: renaming one starts a new series.

Draft from the page names seen on the first live run (2026-10-22); refine against real page text.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Metric:
    key: str
    label: str           # shown in the cockpit (Chinese)
    unit: str = ""
    period: str = ""     # what the number covers; '' = current value
    hint: str = ""       # how to find it on the page (for the model)


def m(key: str, label: str, unit: str = "", period: str = "", hint: str = "") -> Metric:
    return Metric(key, label, unit, period, hint or label)


CATALOG: dict[tuple[str, str], tuple[Metric, ...]] = {
    ("booking", "reviews"): (
        m("review_score", "评分", "/10", hint="overall guest review score out of 10"),
        m("review_count", "评论数", hint="total number of guest reviews the score is based on"),
    ),
    ("booking", "content-score"): (
        m("content_score", "房源页内容分", "%", hint="property page / content score as a percentage"),
    ),
    ("booking", "sales-insights"): (
        m("room_nights", "间夜", period="last_30_days", hint="room nights booked in the period shown"),
        m("revenue", "收入", "THB", "last_30_days", "revenue / room revenue booked in the period"),
        m("adr", "平均房价", "THB", "last_30_days", "average daily rate (ADR)"),
        m("cancellation_rate", "取消率", "%", "last_30_days", "cancellation rate"),
        m("avg_lead_time", "平均提前预订天数", "天", "last_30_days", "average booking window / lead time in days"),
    ),
    ("booking", "pace-report"): (
        m("otb_room_nights", "未来 30 天在手间夜", period="next_30_days", hint="room nights on the books for the period"),
        m("otb_revenue", "未来 30 天在手收入", "THB", "next_30_days", "revenue on the books for the period"),
    ),
    ("booking", "search-rank"): (
        m("search_views", "搜索曝光", period="last_30_days", hint="times the property was seen in search results"),
        m("page_views", "房源页浏览", period="last_30_days", hint="property page views"),
        m("conversion_rate", "转化率", "%", "last_30_days", "conversion / booking rate from page views"),
        m("search_rank", "搜索排名", "名", hint="average or current position in search results"),
    ),
    ("agoda", "landing"): (
        m("review_score", "评分", "/10", hint="overall review score out of 10"),
        m("review_count", "评论数", hint="number of reviews"),
    ),
    ("agoda", "dashboard"): (
        m("room_nights", "间夜", period="last_30_days", hint="room nights / production"),
        m("revenue", "收入", "THB", "last_30_days", "revenue / gross production"),
        m("adr", "平均房价", "THB", "last_30_days", "average daily rate"),
        m("content_score", "内容分", "%", hint="content score / property listing completeness"),
    ),
    ("agoda", "performance"): (
        m("page_views", "房源页浏览", period="last_30_days", hint="property page views"),
        m("conversion_rate", "转化率", "%", "last_30_days", "conversion rate"),
    ),
    ("expedia", "landing"): (
        m("review_score", "评分", "/10", hint="guest rating out of 10 (or out of 5)"),
        m("review_count", "评论数", hint="number of reviews"),
    ),
    ("expedia", "data-insights"): (
        m("room_nights", "间夜", period="last_30_days", hint="room nights"),
        m("revenue", "收入", "THB", "last_30_days", "revenue"),
        m("adr", "平均房价", "THB", "last_30_days", "average daily rate"),
        m("conversion_rate", "转化率", "%", "last_30_days", "conversion rate"),
        m("page_views", "房源页浏览", period="last_30_days", hint="property page views"),
    ),
    ("ctrip", "landing"): (
        m("review_score", "点评分", "/5", hint="点评分 / 综合评分 out of 5"),
        m("review_count", "点评数", hint="点评总数"),
    ),
    ("ctrip", "home"): (
        m("service_score", "服务质量分", hint="服务质量分 / PSI"),
        m("room_nights", "间夜", period="last_30_days", hint="间夜量"),
        m("conversion_rate", "转化率", "%", "last_30_days", "转化率"),
    ),
    ("ctrip", "data-center"): (
        m("page_views", "浏览量", period="last_30_days", hint="浏览量 / 曝光"),
        m("conversion_rate", "转化率", "%", "last_30_days", "转化率"),
        m("rank_in_area", "商圈排名", "名", hint="商圈排名 / 竞争圈排名"),
    ),
    ("google", "landing"): (
        m("review_score", "评分", "/5", hint="average star rating out of 5"),
        m("review_count", "评论数", hint="number of reviews"),
    ),
    ("tripadvisor", "landing"): (
        m("review_score", "评分", "/5", hint="bubble rating out of 5"),
        m("review_count", "评论数", hint="number of reviews"),
    ),
    ("tripadvisor", "analytics"): (
        m("popularity_rank", "当地排名", "名", hint="ranking among hotels in the area (#N of M)"),
        m("page_views", "页面浏览", period="last_30_days", hint="page views / traveler visits"),
    ),
    ("medallia", "satisfaction"): (
        m("overall_satisfaction", "总体满意度", hint="overall satisfaction / overall experience score"),
        m("likelihood_to_recommend", "推荐意愿", hint="likelihood to recommend score"),
        m("response_count", "问卷数", hint="number of survey responses"),
    ),
    ("medallia", "ranker"): (
        m("brand_rank", "品牌内排名", "名", hint="the hotel's rank among comparison hotels"),
    ),
}
