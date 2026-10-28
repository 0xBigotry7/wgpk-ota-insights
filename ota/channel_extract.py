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


MONTHS = {"Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6, "Jul": 7, "Aug": 8, "Sep": 9, "Sept": 9,
          "Oct": 10, "Nov": 11, "Dec": 12}
# Booking pace report: URL period -> (metric prefix, total-column keys already in the catalog, their period).
PACE_PAGES = {
    "pace-report": ("pickup_30d", "_30d", "booked_last_30_days"),
    "pace-90d": ("pickup_90d", "_90d", "booked_last_90_days"),
    "pace-365": ("pace", None, None),
}


def pace_table(text: str) -> tuple[list[str], dict[str, list[float | None]]]:
    """Booking's pace table: stay-month columns ("\tNov\n2026" ... "\tTotal") and tab-separated rows.

    Returns (["2026-11", ..., "total"], {row label: values}); empty when the page shows no such table.
    Cells that are not numbers ("—", blank) are None, never 0.
    """
    head = re.search(r"((?:\t[A-Z][a-z]{2,3}\n20\d{2}\n)+)\tTotal\n", text)
    if not head:
        return [], {}
    cols = [f"{y}-{MONTHS[mo]:02d}" for mo, y in re.findall(r"\t([A-Z][a-z]{2,3})\n(20\d{2})", head[1]) if mo in MONTHS]
    cols.append("total")
    rows: dict[str, list[float | None]] = {}
    for line in text[head.end():].splitlines():
        if line.startswith(("Show total sum", "Breakdown by room")):
            break
        parts = line.split("\t")
        if len(parts) != len(cols) + 1 or not parts[0].strip():
            continue
        cells = []
        for p in parts[1:]:
            p = p.strip().replace(",", "").rstrip("%")
            try:
                cells.append(float(p))
            except ValueError:
                cells.append(None)
        rows.setdefault(parts[0].strip(), cells)       # the first "Your rank" etc. wins; ranks are not read
    return cols, rows


def pace_values(slug: str, text: str) -> list[dict]:
    prefix, total_suffix, total_period = PACE_PAGES[slug]
    cols, rows = pace_table(text)
    if not cols:
        return []
    values = []
    series = (("room_nights", "Room nights"), ("revenue", "Revenue (THB)"), ("adr", "Average daily rate THB"))
    for key, label in series:
        ours, last_year = rows.get(label), rows.get(f"{label} (Last year)")
        peer = rows.get(f"{label} (Peer group)")
        if not ours:
            continue
        for i, col in enumerate(cols):
            if col != "total" and peer and peer[i] is not None:
                values.append({"key": f"{prefix}_{key}_comp", "value": peer[i], "benchmark": None,
                               "quote": f"{label} (Peer group) {col}", "period_override": f"stay_{col}"})
            if ours[i] is None:
                continue
            bench = last_year[i] if last_year else None        # same-time-last-year only; never a peer value
            if col == "total":
                if total_suffix:
                    values.append({"key": f"pace_{key}{total_suffix}", "value": ours[i], "benchmark": None,
                                   "quote": f"{label} Total", "period_override": total_period})
                continue
            values.append({"key": f"{prefix}_{key}", "value": ours[i], "benchmark": bench,
                           "quote": f"{label} {col}", "period_override": f"stay_{col}"})
    return values


def channel_values(cid: str, slug: str, text: str, day: str) -> list[dict] | None:
    values = []

    def add(key: str, pattern: str, period: str | None = None, peer: bool = False) -> None:
        match = re.search(pattern, text, re.MULTILINE)
        if match:
            val = float(match[1].replace(",", ""))
            benchmark = float(match[2].replace(",", "")) if peer else None
            values.append({"key": key, "value": val, "benchmark": benchmark,
                           "quote": match[0][:120], "period_override": period})

    if cid == 'booking' and slug in PACE_PAGES:
        return pace_values(slug, text)
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
