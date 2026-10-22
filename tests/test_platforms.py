import pytest

from ota.platforms import BY_CID, PLATFORMS, fill, signed_out


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
