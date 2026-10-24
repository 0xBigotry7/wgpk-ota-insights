"""Deterministic extraction for newly verified OTA analytics, no guest data or model.

Return None for unsupported pages; [] for a supported page with no valid data.
Date-picker input values are appended by ReadOnlyTab; never infer an arbitrary
custom window is last30 simply because a fixed diagnostic mentions 30 days.
"""
from __future__ import annotations

import datetime as dt
import re

NUM = r"([\d,]+(?:\.\d+)?)"


def source_date(cid: str, slug: str, text: str) -> tuple[str, str] | None:
    if cid == 'booking' and slug.startswith('search-rank'):
        match = re.search(r'Data shown as of (\d{1,2} [A-Za-z]+ 20\d{2})', text)
        if match:
            for fmt in ('%d %b %Y', '%d %B %Y'):
                try:
                    return dt.datetime.strptime(match[1], fmt).date().isoformat(), 'page_data_as_of'
                except ValueError:
                    pass
    if cid == 'ctrip' and slug == 'traffic':
        match = re.search(r'Selected date filters:([^\n]+)', text)
        if match:
            values = re.findall(r'(20\d{2})[-年](\d{1,2})[-月](\d{1,2})日?', match[1])
            if len(values) == 2:
                try:
                    return dt.date(*map(int, values[1])).isoformat(), 'selected_window_end'
                except ValueError:
                    pass
    return None


def selected_period(text: str, day: str) -> str:
    match = re.search(r"Selected date filters:([^\n]+)", text)
    if not match:
        return "native_window"
    values = re.findall(r"(20\d{2})[-年](\d{1,2})[-月](\d{1,2})日?", match[1])
    if len(values) != 2:
        return "native_window"
    try:
        start, end = (dt.date(*map(int, v)) for v in values)
        length = (end - start).days + 1
        if length <= 0:
            return "native_window"
        if end == dt.date.fromisoformat(day) - dt.timedelta(days=1) and length in (7, 14, 28, 30, 90):
            return f"last_{length}_days"
        return f"dates_{start.isoformat()}_{end.isoformat()}"
    except ValueError:
        return "native_window"


def channel_values(cid: str, slug: str, text: str, day: str) -> list[dict] | None:
    values = []

    def add(key: str, pattern: str, period: str | None = None, peer: bool = False) -> None:
        match = re.search(pattern, text, re.MULTILINE)
        if match:
            val = float(match[1].replace(",", ""))
            benchmark = float(match[2].replace(",", "")) if peer else None
            values.append({"key": key, "value": val, "benchmark": benchmark,
                           "quote": match[0][:120], "period_override": period})

    if cid == 'booking' and slug == 'search-rank-30d':
        if 'Selected analytics period: DAYS30' not in text:
            return []
        for key, label in (('search_views', 'Search results views'), ('page_visits', 'Property page visits'),
                           ('bookings', 'Bookings made'), ('availability_for_search', 'Availability for search')):
            add(key, rf'^{label}\s*{NUM}')
        add('click_rate', rf'{NUM}% clicked into your property page[\s\S]*?vs peer group \({NUM}%\)', peer=True)
        add('book_rate', rf'{NUM}% booked your property[\s\S]*?vs peer group \({NUM}%\)', peer=True)
    elif cid == "agoda" and slug == "dashboard":
        # Sales MTD is separate from the 30-day competitor ranks.
        section = text.split("Sales", 1)[-1].split("Reservations", 1)[0]
        for key, label in (("room_nights_mtd", "Room nights"), ("adr_mtd", r"Average daily rate \(THB\)"),
                           ("revenue_mtd", r"Revenue \(THB\)")):
            match = re.search(rf"^{label}\s*{NUM}", section, re.MULTILINE)
            if match:
                values.append({"key": key, "value": float(match[1].replace(",", "")),
                               "benchmark": None, "quote": match[0][:120]})
        add("cancelled_today", rf"^Cancelled bookings\s*{NUM}")
        section = text.split("Your property vs competitor set", 1)[-1]
        for key, label in (("search_results_rank_30d", "Search results"), ("unique_visitors_rank_30d", "Unique visitors"),
                           ("bookings_rank_30d", "Bookings")):
            match = re.search(rf"^{label}\s*{NUM}\s*/\s*\d+", section, re.MULTILINE)
            if match:
                values.append({"key": key, "value": float(match[1].replace(",", "")),
                               "benchmark": None, "quote": match[0][:120]})
    elif cid == "agoda" and slug == "lost-bookings":
        if 'Next 30 days' in text and 'Check-in date' in text:
            add('bookings_lost_30d', rf'{NUM} total bookings lost to other properties')
    elif cid == "ctrip" and slug == "traffic":
        period = selected_period(text, day)
        for key, label in (("search_views", "列表页浏览量"), ("page_visits", "详情页浏览量"),
                           ("bookings", "订单量"), ("click_rate", "列表页转化"),
                           ("book_rate", "下单转化"), ("overall_conversion", "总转化率")):
            add(key, rf"^{label}\s*{NUM}" + ("%" if "rate" in key or "conversion" in key else ""), period)
        add("diagnostic_book_rate_30d", rf"过去30天[^\n]*下单页转化率为{NUM}%，而竞争圈均值为{NUM}%", peer=True)
    elif cid == "ctrip" and slug == "performance":
        # Diagnostic explicitly states future stay dates; independent of sales-table filter.
        add("otb_room_nights_30d", rf"未来30天的已预订间夜为{NUM}，不及竞争圈的平均间夜量{NUM}", peer=True)
        # Both booking-date and stay-date tab labels occur in body text, regardless
        # of selection. Do not extract that table until selected-tab metadata exists.
    elif cid == "ctrip" and slug == "lost-bookings":
        if "过去14天" not in text:
            return []
        for prefix, label in (("bookings", "订单量"), ("room_nights", "间夜数")):
            match = re.search(rf"^{label}\s*{NUM}\s*流入\s*{NUM}\s*流出", text, re.MULTILINE)
            if match:
                for key, group in ((f"won_{prefix}_14d", 1), (f"lost_{prefix}_14d", 2)):
                    values.append({"key": key, "value": float(match[group].replace(",", "")),
                                   "benchmark": None, "quote": match[0][:120]})
    else:
        return None
    return values
