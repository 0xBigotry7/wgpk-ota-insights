import pytest

from ota.platforms import BY_CID, PLATFORMS, fill, page_problem, signed_out


@pytest.mark.parametrize("url,text", [
    ("https://account.booking.com/sign-in?op_token=x", ""),
    ("https://accounts.google.com/v3/signin/identifier", ""),
    ("https://wyndham.okta.com/app/x", ""),
    ("https://passport.ctrip.com/user/login", ""),
    ("https://www.tripadvisor.com/reviews?locationId=1", "Press and hold to confirm you are a human"),
    ("https://apps.expediapartnercentral.com/lodging/home", "Sign in to Partner Central"),
])
def test_signed_out_pages(url, text):
    assert signed_out(url, text)


@pytest.mark.parametrize("url,text", [
    ("https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/home.html?hotel_id=1&ses=a", "Guest reviews 8.6"),
    ("https://ebooking.ctrip.com/comment/commentList", "待回复 0 点评分 4.7"),
])
def test_dashboards_are_not_signed_out(url, text):
    assert signed_out(url, text) is None


def test_booking_placeholders_come_from_landing_url():
    landing = "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/home.html?hotel_id=123&ses=abc&lang=en"
    page = BY_CID["booking"].pages[0]
    assert fill(page.url, landing).endswith("reviews.html?hotel_id=123&lang=en&ses=abc")
    assert fill(page.url, "https://admin.booking.com/") is None


def test_no_page_is_a_form_or_action_endpoint():
    for p in PLATFORMS:
        for u in [p.landing, *(x.url for x in p.pages)]:
            assert not any(w in u.lower() for w in ("submit", "reply", "respond", "update", "save", "delete", "logout"))


BK = "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage"


@pytest.mark.parametrize("requested,final,text,status", [
    # Seen on run 20261022-174905.
    ("https://ycs.agoda.com/mldc/en-us/app/dashboard/1", "https://portal.agoda.com/en-us/Error/NotFound/",
     "We are sorry the page or file not found. 404 Page Not Found", "page_missing"),
    (f"{BK}/content_score.html?hotel_id=1", f"{BK}/403.html?hotel_id=1&authz_type=rb",
     "This page is protected", "page_missing"),
    ("https://ebooking.ctrip.com/datacenter/index", "https://ebooking.ctrip.com/home/oversea", "今日新订 0", "page_missing"),
    ("https://apps.expediapartnercentral.com/supply/data-insights-hub?propertyId=1",
     "https://apps.expediapartnercentral.com/supply/data-insights-hub?propertyId=1",
     "Revenue\nWe're having trouble loading it. Wait a moment, then try again.", "error"),
])
def test_unusable_pages_are_not_ok(requested, final, text, status):
    assert page_problem(requested, final, text)[0] == status


@pytest.mark.parametrize("requested,final", [
    (f"{BK}/showrank.html?hotel_id=1&ses=a", f"{BK}/showrank.html?hotel_id=1&lang=en&ses=a"),
    ("https://wyndhamhotels.medallia.com/x/pages/227?roleId=376", "https://wyndhamhotels.medallia.com/x/pages/227?roleId=376&f.a=b"),
    ("https://www.tripadvisor.com/Owners?locationId=1", "https://www.tripadvisor.com/Owners"),
    ("https://ebooking.ctrip.com/home/oversea?microJump=true", "https://ebooking.ctrip.com/home/oversea?microJump=true"),
])
def test_real_dashboards_pass(requested, final):
    assert page_problem(requested, final, "Search results views 368,843") is None
