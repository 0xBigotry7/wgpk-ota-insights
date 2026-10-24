import asyncio

from ota.channel_extract import channel_values, selected_period, source_date
from ota.readonly import ReadOnlyTab


def test_date_filters_are_required_and_custom_ranges_are_not_30_day_guesses():
    assert selected_period("diagnosis past30 days", "2026-10-24") == "native_window"
    assert selected_period("Selected date filters: 2026年9月24日 | 2026年10月23日", "2026-10-24") == "last_30_days"
    assert selected_period("Selected date filters: 2026-09-25 | 2026-10-23", "2026-10-24") == "dates_2026-09-25_2026-10-23"
    assert selected_period("Selected date filters: 2026-02-30 | 2026-10-23", "2026-10-24") == "native_window"


def test_booking_period_selection_and_source_cutoff_are_independent_of_capture_day():
    text = 'Search results views\n369,668\nProperty page visits\n9,500\nBookings made\n249\n2.57% clicked into your property page\n-18.13% vs peer group (3.14%)\n2.62% booked your property\n+8.18% vs peer group (2.42%)\nAvailability for search\n95.65%\nData shown as of 20 Oct 2026.'
    assert channel_values('booking', 'search-rank-30d', text, '2026-10-24') == []
    v = {x['key']: x for x in channel_values('booking', 'search-rank-30d', text + '\nSelected analytics period: DAYS30', '2026-10-24')}
    assert v['bookings']['value'] == 249
    assert v['click_rate']['benchmark'] == 3.14
    assert source_date('booking', 'search-rank-30d', text) == ('2026-10-20', 'page_data_as_of')
    assert source_date('booking', 'search-rank-30d', 'Data shown as of 31 Feb 2026') is None


def test_ctrip_funnel_counts_rates_and_competitor_diagnostic_keep_separate_scopes():
    text = """过去30天您的订单表现较好，但下单页转化率为0.32%，而竞争圈均值为0.38%
流量趋势
列表页浏览量
83,289
详情页浏览量
41,283
订单量
133
总转化率
0.16%
列表页转化
49.57%
下单转化
0.32%
Selected date filters: 2026-09-24 | 2026-10-23"""
    values = {x['key']: x for x in channel_values('ctrip', 'traffic', text, '2026-10-24')}
    assert values['search_views']['value'] == 83289
    assert values['bookings']['value'] == 133
    assert values['book_rate']['period_override'] == 'last_30_days'
    assert values['book_rate']['benchmark'] is None
    assert values['diagnostic_book_rate_30d']['benchmark'] == 0.38
    assert channel_values('ctrip', 'traffic', '列表页浏览量\n--\n订单量\n-', '2026-10-24') == []


def test_future_otb_never_borrows_book_date_revenue_and_loss_is_not_cancellation():
    text = '您未来30天的已预订间夜为140，不及竞争圈的平均间夜量246.90\n销售额\nTHB\n1,777,728.07'
    values = channel_values('ctrip', 'performance', text, '2026-10-24')
    assert [x['key'] for x in values] == ['otb_room_nights_30d']
    assert values[0]['value'] == 140 and values[0]['benchmark'] == 246.90
    loss = '过去14天\n订单量\n24\n流入\n62\n流出\n间夜数\n72\n流入\n121\n流出'
    v = {x['key']: x['value'] for x in channel_values('ctrip', 'lost-bookings', loss, '2026-10-24')}
    assert v == {'won_bookings_14d': 24, 'lost_bookings_14d': 62, 'won_room_nights_14d': 72, 'lost_room_nights_14d': 121}
    assert channel_values('ctrip', 'lost-bookings', loss.replace('过去14天', '过去7天'), '2026-10-24') == []


def test_agoda_ranks_are_not_counts_or_competitor_averages():
    text = 'Sales\nRoom nights\n782\nAverage daily rate (THB)\n4,592.9\nRevenue (THB)\n2,785,398.5\nReservations\nCancelled bookings\n0\nYour property vs competitor set\nSearch results\n3\n/10\nUnique visitors\n1\n/10\nBookings\n3\n/10'
    v = {x['key']: x for x in channel_values('agoda', 'dashboard', text, '2026-10-24')}
    assert v['room_nights_mtd']['value'] == 782
    assert v['unique_visitors_rank_30d']['value'] == 1
    assert v['unique_visitors_rank_30d']['benchmark'] is None
    assert 'bookings' not in v


def test_only_date_input_values_are_added_to_private_snapshot():
    class Control:
        def __init__(self, value):
            self.value = value

        async def input_value(self):
            return self.value

    class Page:
        url = 'https://ebooking.ctrip.com/ebkgrowth/datacenter/mix/traffic'

        async def inner_text(self, selector):
            return '流量分析'

        def locator(self, selector):
            return self

        async def all(self):
            return [Control('2026年9月24日'), Control('2026年10月23日'), Control('private search text'), Control('123456789')]

    text = asyncio.run(ReadOnlyTab(Page()).text())
    assert 'Selected date filters' in text
    assert 'private' not in text and '123456789' not in text
