"""Which pages to read on each OTA, and how to tell a signed-out page.

Every URL here is a page the hotel's staff would open to look at numbers. None of them is a form
target. Pages marked UNVERIFIED are best guesses until the first manual run on the hotel Mac shows
the real dashboard; until then a wrong guess only produces a "page_missing" snapshot. The saved
link list of each landing page (see readonly.LINKS_JS) is what calibration uses to fix them.

IDs are the ones the review operator already uses (wgpk-reviews/operator_v2/sources).
"""
from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlparse

AGODA_ID = "64055115"
AGODA_AC = f"https://portal.agoda.com/mldc/en-us/app/reporting/analyticscenter/{AGODA_ID}"
EXPEDIA_ID = "111503914"
TRIPADVISOR_ID = "28147689"
BOOKING = "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage"
BOOKING_Q = "hotel_id={hotel_id}&lang=en&ses={ses}"
MEDALLIA = "https://wyndhamhotels.medallia.com/sso/wyndhamhotels/applications/ex_WEB-5/pages"


@dataclass(frozen=True)
class Page:
    slug: str
    url: str                     # absolute, or a template filled from the landing URL's query (Booking)
    verified: bool = False
    settle_ms: int = 0           # extra wait for slow dashboards, on top of config.SETTLE_MS
    retry: bool = True           # one more wait when widgets have not loaded; off where they never will


@dataclass(frozen=True)
class Platform:
    cid: str
    name: str
    landing: str                 # opened first; the session check runs here
    pages: tuple[Page, ...] = field(default_factory=tuple)


PLATFORMS: tuple[Platform, ...] = (
    # Landing pages are the ones the review operator opens every day, so they are known to work with
    # its sessions. verified=True: the URL was taken from a link on the live landing page (first manual
    # run 2026-10-22, run 20261022-163347). The rest are still guesses.
    Platform("booking", "Booking.com", "https://admin.booking.com/", (
        # Booking puts hotel_id and a session token (ses) in every extranet URL; both come from the
        # landing redirect, never from a form.
        Page("reviews", f"{BOOKING}/reviews.html?{BOOKING_Q}", verified=True),
        # Redirects to 403.html for this login (needs the "Property details" permission).
        Page("content-score", f"{BOOKING}/content_score.html?{BOOKING_Q}", verified=True),
        Page("sales-insights", f"{BOOKING}/statistics/sales_insights.html?{BOOKING_Q}"
                               "&benchmark=PEER_GROUP&reservationType=BOOKED", verified=True),
        # Same report over a fixed window, book date: the Total column is the window's figure. fromDate/untilDate
        # were seen on links of the live page (run 20261023-113000); {from30}/{from90}/{until} are filled per run.
        Page("sales-30d", f"{BOOKING}/statistics/sales_insights.html?{BOOKING_Q}&benchmark=PEER_GROUP"
                          "&reservationType=BOOKED&fromDate={from30}&untilDate={until}&granularity=MONTHLY", verified=True),
        Page("sales-90d", f"{BOOKING}/statistics/sales_insights.html?{BOOKING_Q}&benchmark=PEER_GROUP"
                          "&reservationType=BOOKED&fromDate={from90}&untilDate={until}&granularity=MONTHLY", verified=True),
        Page("pace-report", f"{BOOKING}/statistics/pace_report.html?{BOOKING_Q}"
                            "&period=DAYS30&benchmark=PEER_GROUP", verified=True),
        # The selector offers "Last 90 days"; DAYS90 follows the DAYS30 pattern but is not seen in a link yet.
        Page("pace-90d", f"{BOOKING}/statistics/pace_report.html?{BOOKING_Q}"
                         "&period=DAYS90&benchmark=PEER_GROUP", verified=True),     # read daily since 10-23
        # On the books per stay month vs same time last year (bookings within 365 days), and per stay date for
        # the next 7 days (DAILY view shows 7 dates without paging). Verified read-only 2026-10-28 14:46.
        Page("pace-365", f"{BOOKING}/statistics/pace_report.html?{BOOKING_Q}&period=DAYS365&benchmark=YEAR_OVER_YEAR"
                         "&granularity=MONTHLY&showTotals=true", verified=True),
        Page("pace-7d", f"{BOOKING}/statistics/pace_report.html?{BOOKING_Q}&period=DAYS365&benchmark=YEAR_OVER_YEAR"
                        "&granularity=DAILY&showTotals=true", verified=True),
        Page("search-rank", f"{BOOKING}/showrank.html?{BOOKING_Q}", verified=True),
        Page("search-rank-30d", f"{BOOKING}/showrank.html?{BOOKING_Q}&period=DAYS30", verified=True),
        # Opened read-only on 2026-10-23 18:55-19:00 (Gary approved the discovery). The Analytics dashboard
        # and the ranking dashboard both take period=DAYS30/DAYS90 in the URL; booker insights shows the
        # travel-purpose table. cancellation_characteristics / genius_report / promotions.html do not exist
        # ("Sorry, this page isn't working"); sales_insights ignores reservationType=CANCELLED.
        Page("analytics-30d", f"{BOOKING}/statistics/dashboard.html?{BOOKING_Q}&period=DAYS30&benchmark=YEAR_OVER_YEAR",
             verified=True),
        Page("analytics-90d", f"{BOOKING}/statistics/dashboard.html?{BOOKING_Q}&period=DAYS90&benchmark=YEAR_OVER_YEAR",
             verified=True),
        Page("search-rank-90d", f"{BOOKING}/showrank.html?{BOOKING_Q}&period=DAYS90", verified=True),
        Page("booker-insights", f"{BOOKING}/statistics/booker_insights.html?{BOOKING_Q}", verified=True),
        Page("genius", f"{BOOKING}/genius/room_select.html?{BOOKING_Q}", verified=True),
        Page("opportunities", f"{BOOKING}/opportunities.html?{BOOKING_Q}", verified=True),
        Page("competitive-set", f"{BOOKING}/statistics/competitiveset.html?{BOOKING_Q}&activeTab=competitive_set",
             verified=True),
        Page("inbox", f"{BOOKING}/messaging/inbox.html?{BOOKING_Q}", verified=True),
    )),
    Platform("agoda", "Agoda YCS", f"https://portal.agoda.com/mldc/en-us/app/setting/review/{AGODA_ID}", (
        Page("inbox", f"https://portal.agoda.com/mldc/en-us/app/hermes/inbox/ycs/{AGODA_ID}", verified=True),
        # Partner Portal reporting, opened read-only 2026-10-23. The Analytics centre has one URL per tab
        # (analyticsTab=...); Property performance takes dateRange.
        Page("dashboard", f"https://portal.agoda.com/mldc/en-us/app/reporting/dashboard/{AGODA_ID}", verified=True),
        Page("lost-bookings", f"{AGODA_AC}?analyticsTab=LostBookingInsights", verified=True),
        # dateRange=last30Days shows "Booked in last 30 days"; last90Days silently falls back to 365 days.
        Page("performance-30d", f"{AGODA_AC}?analyticsTab=PropertyPerformance&dateRange=last30Days&comparison=competitorSet",
             verified=True),
        Page("traveler-insights", f"{AGODA_AC}?analyticsTab=TravelerInsights", verified=True),
        Page("revenue-distribution", f"{AGODA_AC}?analyticsTab=RevenueDistribution", verified=True),
        Page("content-score", f"{AGODA_AC}?analyticsTab=ContentScore", verified=True),
        Page("program-performance", f"{AGODA_AC}?analyticsTab=ProgramPerformance", verified=True),
    )),
    Platform("expedia", "Expedia", "https://apps.expediapartnercentral.com/lodging/review/user_reviews.html"
                                   f"?htid={EXPEDIA_ID}", (
        # The supply app's metric tiles never load for this login: 5 / 3 / 3 tiles still say "We're having trouble
        # loading it" after 90 s (2026-10-23 19:55), so it is a permission issue, not timing. Still read without
        # extra wait or retry, so page_status keeps reporting the error until a person fixes the account.
        Page("data-insights", "https://apps.expediapartnercentral.com/supply/data-insights-hub"
                              f"?propertyId={EXPEDIA_ID}", verified=True, retry=False),
        Page("home", f"https://apps.expediapartnercentral.com/supply/home?propertyId={EXPEDIA_ID}",
             verified=True, retry=False),
        # Older report pages linked from the hub; they need a separate legacy Partner Central sign-in (a person).
        Page("reporting-suite", "https://apps.expediapartnercentral.com/lodging/partner-reporting-suite/index.html"
                                f"?htid={EXPEDIA_ID}", verified=True),
        Page("booking-insights", "https://apps.expediapartnercentral.com/lodging/booking-insights/index.html"
                                 f"?htid={EXPEDIA_ID}", verified=True),
        # rate-insights loads its date grid (Expedia.co.th, THB) but its tiles fail like the hub's.
        Page("rate-insights", f"https://apps.expediapartnercentral.com/supply/rate-insights?propertyId={EXPEDIA_ID}",
             verified=True, retry=False),
    )),
    Platform("ctrip", "Ctrip eBooking", "https://ebooking.ctrip.com/comment/commentList?microJump=true", (
        Page("home", "https://ebooking.ctrip.com/home/oversea?microJump=true", verified=True),
        # Verified by clicking the actual Data analysis nav, 2026-10-24.
        Page("data-center", "https://ebooking.ctrip.com/ebkgrowth/datacenter/mix/overview", verified=True),
        Page("traffic", "https://ebooking.ctrip.com/ebkgrowth/datacenter/mix/traffic", verified=True),
        Page("performance", "https://ebooking.ctrip.com/ebkgrowth/datacenter/mix/performance", verified=True),
        Page("lost-bookings", "https://ebooking.ctrip.com/ebkgrowth/datacenter/oversea/booking/insights", verified=True),
    )),
    Platform("google", "Google Business", "https://business.google.com/u/1/reviews", ()),
    Platform("tripadvisor", "TripAdvisor",
             f"https://www.tripadvisor.com/reviews?locationId={TRIPADVISOR_ID}&screen=allreviews", (
        Page("analytics", f"https://www.tripadvisor.com/analytics?locationId={TRIPADVISOR_ID}", verified=True),
        Page("owner-home", f"https://www.tripadvisor.com/Owners?locationId={TRIPADVISOR_ID}"),     # UNVERIFIED
    )),
    Platform("medallia", "Medallia", f"{MEDALLIA}/251?roleId=376", (
        Page("home", f"{MEDALLIA}/548?roleId=376", verified=True),
        Page("satisfaction", f"{MEDALLIA}/227?roleId=376", verified=True),
        Page("ranker", f"{MEDALLIA}/581?roleId=376", verified=True),
        Page("analytics", f"{MEDALLIA}/664?roleId=376", verified=True),
    )),
)

BY_CID = {p.cid: p for p in PLATFORMS}

# Hosts that only ever serve a sign-in or SSO step.
LOGIN_HOSTS = ("account.booking.com", "accounts.google.com", "sign-in.wyndham.com", "login.microsoftonline.com",
               "passport.ctrip.com", "www.expediapartnercentral.com/Account/Logon")
LOGIN_PATH = re.compile(r"/(sign-?in|login|logon|signin|auth/login)(\b|/|\?|$)", re.IGNORECASE)
LOGIN_TEXT = re.compile(r"\b(sign in to|log in to your account|enter your password|verification code|"
                        r"verify it's you|two-step|captcha|press and hold)\b|登录您的账户|请登录|验证码", re.IGNORECASE)


def signed_out(url: str, text: str) -> str | None:
    """Why this page looks like a sign-in/challenge step, or None when it looks like the extranet."""
    u = urlparse(url)
    full = f"{u.netloc}{u.path}"
    if any(full.startswith(h) or u.netloc == h for h in LOGIN_HOSTS):
        return f"login host {u.netloc}"
    if "okta" in u.netloc.lower():
        return f"SSO host {u.netloc}"
    if LOGIN_PATH.search(u.path):
        return f"login path {u.path}"
    head = text[:3000]
    if m := LOGIN_TEXT.search(head):
        return f"login wording '{m.group(0)}'"
    return None


# Pages that loaded but are not the dashboard asked for. Seen on run 20261022-174905.
ERROR_PATH = re.compile(r"/(403|404|error|notfound)(\.html)?(/|$)", re.IGNORECASE)
MISSING_TEXT = re.compile(r"404 Page Not Found|page or file not found|This page is protected|页面不存在|"
                          r"Sorry, this page isn't working",
                          re.IGNORECASE)
NOT_LOADED_TEXT = re.compile(r"We're having trouble loading it", re.IGNORECASE)


def _last_segment(url: str) -> str:
    parts = [p for p in urlparse(url).path.split("/") if p]
    return parts[-1].lower() if parts else ""


def page_problem(requested: str, final: str, text: str) -> tuple[str, str] | None:
    """(status, detail) when a page that loaded is not usable, else None.

    page_missing: an error/403 page, or a redirect away from the page asked for (e.g. back to the home
    page). error: the page is right but its numbers did not load.
    """
    path = urlparse(final).path
    if ERROR_PATH.search(path):
        return "page_missing", f"redirected to {path}"
    if m := MISSING_TEXT.search(text[:3000]):
        return "page_missing", f"page says '{m.group(0)}'"
    want = _last_segment(requested)
    if want and want not in path.lower():
        return "page_missing", f"redirected to {path}"
    if n := len(NOT_LOADED_TEXT.findall(text)):
        return "error", f"{n} widget(s) did not load"
    return None


BKK = dt.timezone(dt.timedelta(hours=7))


def date_window(today: dt.date | None = None) -> dict[str, str]:
    """{until} = yesterday (the last complete day), {from30}/{from90} = the first day of that 30/90-day window."""
    until = (today or dt.datetime.now(BKK).date()) - dt.timedelta(days=1)
    return {"until": until.isoformat(), "from30": (until - dt.timedelta(days=29)).isoformat(),
            "from90": (until - dt.timedelta(days=89)).isoformat()}


def fill(url: str, landing_url: str, today: dt.date | None = None) -> str | None:
    """Fill {hotel_id}/{ses} from the landing URL's query and the date window; None when a placeholder has no value."""
    if "{" not in url:
        return url
    q = date_window(today) | {k: v[0] for k, v in parse_qs(urlparse(landing_url).query).items()}
    try:
        return url.format(**q)
    except KeyError:
        return None
