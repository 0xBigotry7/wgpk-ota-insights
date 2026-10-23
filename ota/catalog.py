"""Which numbers to read off which page. Keys are stable forever: renaming one starts a new series.

Calibrated against the page text of run 20261022-174905. Hints quote the labels as they appear on
the page, so the model can find them; periods say what window the page shows by default.
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
    # content-score needs a permission the hotel login lacks (403); its number is on search-rank instead.
    ("booking", "sales-insights"): (
        # Table "Your sales performance": one column per month (book date) and a Total column. The last
        # month column is the current month to date; benchmark = the "(Peer group)" row in that column.
        m("room_nights_mtd", "本月至今间夜", period="month_to_date",
          hint="'Room nights' row, last month column before Total; benchmark: 'Room nights (Peer group)' same column"),
        m("revenue_mtd", "本月至今收入", "THB", "month_to_date",
          "'Revenue (THB)' row, last month column before Total; benchmark: '(Peer group)' row same column"),
        m("adr_mtd", "本月至今平均房价", "THB", "month_to_date",
          "'Average daily rate THB' row, last month column before Total; benchmark: '(Peer group)' row"),
        m("revenue_rank_mtd", "本月收入同类排名", "名", "month_to_date",
          "'Your rank' under Revenue, last month column: the N in 'N out of 26'"),
        m("adr_rank_mtd", "本月房价同类排名", "名", "month_to_date",
          "'Your rank' under Average daily rate, last month column: the N in 'N out of 26'"),
        m("room_nights_last_month", "上月间夜", period="last_month",
          hint="'Room nights' row, second-to-last month column; benchmark: '(Peer group)' row same column"),
        m("revenue_last_month", "上月收入", "THB", "last_month",
          "'Revenue (THB)' row, second-to-last month column; benchmark: '(Peer group)' row same column"),
        m("adr_last_month", "上月平均房价", "THB", "last_month",
          "'Average daily rate THB' row, second-to-last month column; benchmark: '(Peer group)' row"),
        m("revenue_rank_last_month", "上月收入同类排名", "名", "last_month",
          "'Your rank' under Revenue, second-to-last month column: N in 'N out of 26'"),
        m("peer_group_size", "同类酒店数", period="", hint="the M in 'N out of M' in the Your rank rows"),
    ),
    # sales-30d / sales-90d: the same table over a fixed book-date window (from the URL); the Total column is
    # the window's figure, benchmark = the "(Peer group)" row's Total, rank = "Your rank" in the Total column.
    **{("booking", f"sales-{n}d"): (
        m(f"room_nights_{n}d", f"近{n}天间夜", period=f"last_{n}_days",
          hint="'Room nights' row, Total column; benchmark: 'Room nights (Peer group)' row, Total column"),
        m(f"revenue_{n}d", f"近{n}天收入", "THB", f"last_{n}_days",
          "'Revenue (THB)' row, Total column; benchmark: its '(Peer group)' row, Total column"),
        m(f"adr_{n}d", f"近{n}天平均房价", "THB", f"last_{n}_days",
          "'Average daily rate THB' row, Total column; benchmark: its '(Peer group)' row, Total column"),
        m(f"room_nights_rank_{n}d", f"近{n}天间夜同类排名", "名", f"last_{n}_days",
          "'Your rank' under Room nights, Total column"),
        m(f"revenue_rank_{n}d", f"近{n}天收入同类排名", "名", f"last_{n}_days",
          "'Your rank' under Revenue, Total column"),
        m(f"adr_rank_{n}d", f"近{n}天房价同类排名", "名", f"last_{n}_days",
          "'Your rank' under Average daily rate, Total column"),
    ) for n in (30, 90)},
    ("booking", "pace-90d"): (
        m("pace_room_nights_90d", "近90天新增未来间夜", period="booked_last_90_days",
          hint="'Total' row at the end of 'Breakdown by room and rate': room nights"),
        m("pace_revenue_90d", "近90天新增未来收入", "THB", "booked_last_90_days", "'Total' row of the breakdown: revenue (THB)"),
        m("pace_adr_90d", "近90天新增未来平均房价", "THB", "booked_last_90_days",
          "'Total' row of the breakdown: average daily rate (THB)"),
    ),
    ("booking", "pace-report"): (
        # Future stays booked within the last 30 days (URL period=DAYS30); the "Total" row of the breakdown.
        m("pace_room_nights_30d", "近30天新增未来间夜", period="booked_last_30_days",
          hint="'Total' row at the end of 'Breakdown by room and rate': room nights"),
        m("pace_revenue_30d", "近30天新增未来收入", "THB", "booked_last_30_days",
          "'Total' row of the breakdown: revenue (THB)"),
        m("pace_adr_30d", "近30天新增未来平均房价", "THB", "booked_last_30_days",
          "'Total' row of the breakdown: average daily rate (THB)"),
    ),
    ("booking", "search-rank"): (
        # "Factors influencing your search ranking" cover the last 90 days.
        m("rank_factor_adr_90d", "排名因素：近90天平均房价", "THB", "last_90_days", "factor 'Average daily rate' (THB)"),
        m("property_page_score", "房源页完整度", "%", hint="factor 'Property page score' percentage"),
        m("conversion_rate_90d", "近90天转化率", "%", "last_90_days", "factor 'Conversion rate' percentage"),
        # "How your searches turned into bookings" funnel, default window; comparisons vs peer group.
        m("search_views", "搜索曝光", period="funnel", hint="'Search results views' count"),
        m("search_views_vs_peer", "搜索曝光 较同类", "%", "funnel",
          "the signed % under 'Search results views' that says 'vs peer group' (e.g. +36.93 or -5.1)"),
        m("page_visits", "房源页访问", period="funnel", hint="'Property page visits' count"),
        m("bookings", "预订数", period="funnel", hint="'Bookings made' count"),
        m("click_rate", "搜索→点击率", "%", "funnel",
          "'% clicked into your property page'; benchmark: the peer group % in brackets"),
        m("book_rate", "访问→预订率", "%", "funnel",
          "'% booked your property'; benchmark: the peer group % in brackets"),
        m("availability_for_search", "可售率", "%", "funnel", "'Availability for search' percentage"),
        m("compset_views_rank", "竞品组曝光排名", "名", "last_90_days",
          "Competition overview, 'Search results views' N/M 'Within your competitive set': N"),
        m("compset_size", "竞品组酒店数", period="last_90_days", hint="the M in that N/M within competitive set"),
        m("area_views_rank", "区域曝光排名", "名", "last_90_days",
          "Competition overview, N/M 'Within Kamala Beach': N"),
        m("area_size", "区域酒店数", period="last_90_days", hint="the M in that N/M within Kamala Beach"),
    ),
    ("agoda", "landing"): (
        # The page shows e.g. "8.7 Excellent / Based on 258 reviews"; a bare "0" near the top is the nav's
        # unread counter, not a score.
        m("review_score", "评分", "/10", hint="overall score shown with a verdict word (e.g. '8.7 Excellent') "
                                            "just above 'Based on N reviews'; not the category scores"),
        m("review_count", "评论数", hint="number of reviews"),
    ),
    ("expedia", "landing"): (
        m("review_score", "评分", "/10", hint="guest rating out of 10 (or out of 5)"),
        m("review_count", "评论数", hint="number of reviews"),
    ),
    ("expedia", "data-insights"): (
        # "Stays, last 28 days, vs. competitive set" tiles; they sometimes fail to load (then absent).
        m("revenue_28d", "近28天收入", "USD", "last_28_days", "tile 'Revenue'; benchmark: competitive set value"),
        m("room_nights_28d", "近28天间夜", period="last_28_days", hint="tile 'Room nights'"),
        m("page_views_28d", "近28天页面浏览", period="last_28_days", hint="tile 'Page views'"),
        m("conversion_rate_28d", "近28天转化率", "%", "last_28_days", "tile 'Conversion rate'"),
        m("avg_sort_order", "平均排序位置", "位", hint="'Average sort order'"),
        m("lowest_rate_next_28d", "未来28天最低价均值", "USD", "next_28_days",
          "Competitive pricing insights 'Average lowest rate' ($); benchmark: 'Competitive set: $N'"),
    ),
    ("expedia", "home"): (
        m("lowest_rate_next_90d", "未来90天最低价均值", "USD", "next_90_days",
          "Rate comparisons 'Average lowest rate' ($); benchmark: 'Competitive set: $N' only if N > 0"),
    ),
    ("ctrip", "landing"): (
        # eBooking shows the Trip.com score as "9.2 / 10" (酒店评分贴纸), not out of 5.
        m("review_score", "点评分", "/10", hint="the hotel score shown as 'N.N / 10' next to 酒店评分贴纸"),
        m("review_count", "点评数", hint="点评总数"),
    ),
    ("ctrip", "home"): (
        m("todays_new_orders", "今日新订", hint="'今日新订' count"),
        m("pending_review_replies", "待回复点评", hint="'待回复点评' count"),
        m("pending_qa_replies", "待回复问答", hint="'待回复问答' count"),
    ),
    ("ctrip", "data-center"): (
        m("page_views", "浏览量", period="last_30_days", hint="浏览量 / 曝光"),
        m("conversion_rate", "转化率", "%", "last_30_days", "转化率"),
        m("rank_in_area", "商圈排名", "名", hint="商圈排名 / 竞争圈排名"),
    ),
    ("google", "landing"): (
        m("review_score", "评分", "/5", hint="average star rating out of 5 (only if a summary is shown)"),
        m("review_count", "评论数", hint="number of reviews (only if a summary is shown)"),
    ),
    ("tripadvisor", "landing"): (
        m("review_score", "评分", "/5", hint="bubble rating out of 5, shown before '| N reviews'"),
        m("review_count", "评论数", hint="the N in 'N reviews' next to the rating"),
    ),
    ("tripadvisor", "analytics"): (
        # Performance tab, "Last 30 days". Each number is followed by an unsigned % change and its label.
        m("rating", "评分", "/5", hint="rating shown as 'N/5'"),
        m("popularity_rank", "当地排名", "名", hint="the N in '#N of M hotels in Kamala'"),
        m("popularity_of", "当地酒店数", hint="the M in '#N of M hotels in Kamala'"),
        m("listing_impressions", "列表曝光", period="last_30_days", hint="number just before 'Listing impressions'"),
        m("unique_visitors", "独立访客", period="last_30_days", hint="number just before 'Unique page visitors'"),
        m("direct_referrals", "直接导流", period="last_30_days", hint="number just before 'Direct referrals'"),
        m("booking_clicks", "预订点击", period="last_30_days", hint="number just before 'Booking clicks'"),
    ),
    ("medallia", "home"): (
        # Property Dashboard dials, "最近 12 个月".
        m("nps_12m", "NPS（近12月）", period="last_12_months", hint="'Net Promotor Score (NPS)' dial value"),
        m("osat_12m", "整体满意度（近12月）", "/10", "last_12_months", "'Overall Satisfaction' dial value"),
        m("social_score_12m", "社交点评综合分", "/5", "last_12_months", "'Overall Social Reviews Score' dial value"),
        m("tripadvisor_rating_12m", "TripAdvisor 评分", "/5", "last_12_months", "'TripAdvisor Rating' dial value"),
        m("rapid_response_pct", "快速回复率", "%", "last_12_months", "'Rapid Responses %' dial value"),
    ),
    ("medallia", "satisfaction"): (
        # Table "满意度：分数": 13 month columns, then 总计, 基准 (Brand / Global Region), 差异.
        # value = the 总计 column, benchmark = the 基准 column.
        *(m(k, lab, unit, "last_13_months", f"row '{row}': 总计 value; benchmark: 基准 value")
          for k, lab, unit, row in (
              ("osat", "整体满意度", "/10", "整体满意度"), ("nps", "NPS", "", "NPS"),
              ("problem_incidence", "问题发生率", "%", "Problem Incidence %"),
              ("checkin_score", "入住评分", "/10", "登记入住"), ("checkout_score", "退房评分", "/10", "退房"),
              ("service_score", "服务评分", "/10", "服务"), ("exterior_score", "外观评分", "/10", "酒店外观"),
              ("room_score", "客房评分", "/10", "客房"), ("cleanliness_score", "清洁度评分", "/10", "清洁度"),
              ("internet_score", "网络评分", "/10", "互联网"), ("breakfast_score", "早餐评分", "/10", "Breakfast"),
              ("fnb_score", "餐饮评分", "/10", "餐饮"), ("value_score", "性价比评分", "/10", "Value for the Money"),
              ("pool_score", "泳池评分", "/10", "Pool"), ("fitness_score", "健身房评分", "/10", "Fitness Center"),
              ("rewards_enrollment_offered", "入住时邀请入会比例", "%", "Offered Enrollment in Rewards Program at Check-in"),
          )),
        m("osat_latest_month", "整体满意度（本月）", "/10", "latest_month",
          "row '整体满意度': the last month column (just before 总计)"),
        m("nps_latest_month", "NPS（本月）", period="latest_month", hint="row 'NPS': the last month column"),
        # Section 评论网站 (5 分范围): each site's '整体分数' row, 总计 and 基准.
        *(m(f"site_score_{k}", f"{name} 口碑分", "/5", "last_13_months",
            f"under '{name}' in 评论网站: the '整体分数' row 总计 value; benchmark: 基准 value")
          for k, name in (("all", "所有评论网站"), ("agoda", "Agoda"), ("booking", "Booking.com"), ("ctrip", "Ctrip.com"),
                          ("expedia", "Expedia"), ("google", "Google"), ("tripadvisor", "TripAdvisor"))),
    ),
    ("medallia", "ranker"): (
        # Only the brand row is visible at this role: the hotel's own figures, no peer ranking.
        m("survey_count_12m", "问卷数（近12月）", period="last_12_months", hint="the 记录数 column of the row"),
        m("mgmt_response_pct", "管理层回复率", "%", "last_12_months", "the 'Management Response Percent' column"),
        m("rapid_response_hours", "快速回复耗时", "小时", "last_12_months", "the 'Rapid Response Time (In Hours)' column"),
    ),
    ("medallia", "analytics"): (
        # Customer Profile table: monthly columns, then 总计, 基准, 差异. value = 总计, benchmark = 基准.
        *(m(k, lab, "%", "last_12_months", f"{where}: 总计 %; benchmark: 基准 %") for k, lab, where in (
            ("leisure_share", "休闲客占比", "旅行类型 row '个人/休闲'"),
            ("rewards_member_share", "会员占比", "奖励会员 row '是'"),
            ("had_problem_share", "遇到问题占比", "经历的问题 row '是'"),
            ("problem_checkin", "问题：入住", "Problem Areas row 'Check-in'"),
            ("problem_checkout", "问题：退房", "Problem Areas row 'Check-out'"),
            ("problem_hvac", "问题：空调通风", "Problem Areas row 'Heating/cooling/ventilation system'"),
            ("problem_cleanliness", "问题：客房清洁", "Problem Areas row 'Guestroom cleanliness'"),
            ("problem_noise", "问题：噪音", "Problem Areas row 'Noise'"),
            ("problem_repairs", "问题：设施损坏", "Problem Areas row 'Broken items/repairs'"),
            ("problem_hot_water", "问题：水压热水", "Problem Areas row 'Water pressure/hot water'"),
            ("problem_staff", "问题：员工服务", "Problem Areas row 'Staff service'"),
            ("problem_fnb", "问题：餐饮", "Problem Areas row 'Food and beverage'"),
        )),
    ),
}
