"""Which pages to read on each OTA, and how to tell a signed-out page.

Every URL here is a page the hotel's staff would open to look at numbers. None of them is a form
target. Pages marked UNVERIFIED are best guesses until the first manual run on the hotel Mac shows
the real dashboard; until then a wrong guess only produces a "page_missing" snapshot. The saved
link list of each landing page (see readonly.LINKS_JS) is what calibration uses to fix them.

IDs are the ones the review operator already uses (wgpk-reviews/operator_v2/sources).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlparse

AGODA_ID = "64055115"
EXPEDIA_ID = "111503914"
TRIPADVISOR_ID = "28147689"


@dataclass(frozen=True)
class Page:
    slug: str
    url: str                     # absolute, or a template filled from the landing URL's query (Booking)
    verified: bool = False


@dataclass(frozen=True)
class Platform:
    cid: str
    name: str
    landing: str                 # opened first; the session check runs here
    pages: tuple[Page, ...] = field(default_factory=tuple)


PLATFORMS: tuple[Platform, ...] = (
    # Landing pages are the ones the review operator opens every day, so they are known to work with
    # its sessions. The extra pages are what calibration fills in.
    Platform("booking", "Booking.com", "https://admin.booking.com/", (
        # Booking puts hotel_id and a session token (ses) in every extranet URL; both come from the
        # landing redirect, never from a form.
        Page("reviews", "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/reviews.html"
                        "?hotel_id={hotel_id}&ses={ses}", verified=True),
        Page("analytics", "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/analytics.html"
                          "?hotel_id={hotel_id}&ses={ses}"),                       # UNVERIFIED
        Page("property-page-score", "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/"
                                    "property_page_score.html?hotel_id={hotel_id}&ses={ses}"),  # UNVERIFIED
        Page("inbox", "https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/messaging/inbox.html"
                      "?hotel_id={hotel_id}&ses={ses}"),                           # UNVERIFIED
    )),
    Platform("agoda", "Agoda YCS", f"https://portal.agoda.com/mldc/en-us/app/setting/review/{AGODA_ID}", (
        Page("dashboard", f"https://ycs.agoda.com/mldc/en-us/app/dashboard/{AGODA_ID}"),           # UNVERIFIED
        Page("performance", f"https://ycs.agoda.com/mldc/en-us/app/reports/performance/{AGODA_ID}"),  # UNVERIFIED
    )),
    Platform("expedia", "Expedia", "https://apps.expediapartnercentral.com/lodging/review/user_reviews.html"
                                   f"?htid={EXPEDIA_ID}", (
        Page("home", f"https://apps.expediapartnercentral.com/lodging/home/home?htid={EXPEDIA_ID}"),  # UNVERIFIED
        Page("analytics", "https://apps.expediapartnercentral.com/lodging/analytics/home.html"
                          f"?htid={EXPEDIA_ID}"),                                  # UNVERIFIED
    )),
    Platform("ctrip", "Ctrip eBooking", "https://ebooking.ctrip.com/comment/commentList?microJump=true", (
        Page("home", "https://ebooking.ctrip.com/home/mainland"),                  # UNVERIFIED
        Page("data-center", "https://ebooking.ctrip.com/datacenter/index"),        # UNVERIFIED
    )),
    Platform("google", "Google Business", "https://business.google.com/u/1/reviews", ()),
    Platform("tripadvisor", "TripAdvisor",
             f"https://www.tripadvisor.com/reviews?locationId={TRIPADVISOR_ID}&screen=allreviews", (
        Page("owner-home", f"https://www.tripadvisor.com/Owners?locationId={TRIPADVISOR_ID}"),     # UNVERIFIED
    )),
    Platform("medallia", "Medallia", "https://wyndhamhotels.medallia.com/sso/wyndhamhotels/applications/"
                                     "ex_WEB-5/pages/251?roleId=376", ()),
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


def fill(url: str, landing_url: str) -> str | None:
    """Fill {hotel_id}/{ses} from the landing URL's query; None when a placeholder has no value."""
    if "{" not in url:
        return url
    q = {k: v[0] for k, v in parse_qs(urlparse(landing_url).query).items()}
    try:
        return url.format(**q)
    except KeyError:
        return None
