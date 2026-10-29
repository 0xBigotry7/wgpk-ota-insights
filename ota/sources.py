"""Agent-requested data sources: the ota agent asks for a new OTA page, the collector probes it once and, when it
is a readable analysis page, reads it every day with the agent's own catalog (cockpit contract: docs/AGENT-API.md,
"Data sources the agent adds").

The agent never drives a browser. This module is the only path from its requests to the operator's Chrome, and
the limits are enforced here in code as well as in the Worker: known OTA extranet hosts only, no URL that suggests
a write, message, inbox, payment or account action, open-and-read only (the collector never clicks), at most
MAX_PROBES_PER_DAY probes outside the review windows while holding the operator's lock, at most MAX_ACTIVE pages
in the daily run, and a page that turns out to be a sign-in, an error or a guest list is rejected. Text sent to
the cockpit has e-mails, phone numbers and long reference numbers masked and is capped at SAMPLE_MAX bytes.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import urllib.parse
import urllib.request
from pathlib import Path

from . import config
from .catalog import Metric

# host -> platform id; anything else is refused
HOSTS = {
    "admin.booking.com": "booking", "portal.agoda.com": "agoda", "ycs.agoda.com": "agoda",
    "apps.expediapartnercentral.com": "expedia", "ebooking.ctrip.com": "ctrip", "www.tripadvisor.com": "tripadvisor",
    "wyndhamhotels.medallia.com": "medallia", "business.google.com": "google",
}
DENY = re.compile(r"reply|respond|submit|save|update|edit|delete|remove|log-?out|sign-?out|sign-?in|log-?in|"
                  r"messag|inbox|hermes|chat|payment|payout|invoice|bank|password|permission|/users?\b|"
                  r"refund|confirm|approve|accept|decline|upload|cancel_res", re.I)
GUEST_MARKERS = re.compile(r"Guest name|Booker name|Booked by|Reservation (?:number|ID|no)|Booking number|"
                           r"Confirmation (?:number|code)|客人姓名|预订人|入住人|订单号|联系人", re.I)
MAX_ACTIVE = 10
MAX_PROBES_PER_DAY = 3
SAMPLE_MAX = 20_000
# Fixed collector pages whose text is shared with the agent (analysis pages, no guest data).
BUILTIN = (("booking", "genius"), ("booking", "competitive-set"), ("booking", "opportunities"),
           ("agoda", "traveler-insights"), ("agoda", "revenue-distribution"), ("agoda", "content-score"))
# The cockpit's urlProblem rules (cockpit/src/sources.js), applied here as well: whole-word verbs of the path and
# query, guest-conversation words anywhere.
DENY_WORDS = {"reply", "replies", "respond", "submit", "save", "update", "edit", "delete", "remove", "cancel", "close",
              "logout", "signout", "login", "signin", "payment", "payments", "payout", "payouts", "invoice", "invoices",
              "bank", "password", "confirm", "publish", "toggle", "approve", "accept", "decline", "modify", "create"}
DENY_ANY = re.compile(r"(message|inbox|chat|conversation|review|guest[-_]?list|reservation[-_]?detail)", re.I)
SESSION_KEYS = {"ses", "session", "sid", "token", "t", "lang", "hotel_id"}
MAX_LINKS = 200
# The link catalog is stricter than a request check: analysis pages only (an allowlist), never anything that names a
# reservation, an order, a survey response, an export or a setup flow. Medallia and Google pages are left out:
# their pages are numbered, so the URL cannot tell an analysis page from one guest's survey.
LINK_PLATFORMS = ("booking", "agoda", "expedia", "ctrip")
LINK_ALLOW = re.compile(r"statistic|analytic|insight|report|pace|rank|opportunit|competitive|genius|demand|market|"
                        r"performance|dashboard|content_?score|data-?center|traffic", re.I)
LINK_DENY = re.compile(r"res_?id|booking_?id|bookingitemid|reservation|postbook|/bookings?(?:[/?#.]|$)|booking\.html|"
                       r"order|comment|survey|feedback|forced_action|export|download|/api/|finance|payout|setup|"
                       r"blockout|promotion|campaign|travelads|co_add|capacity|setting|roomsetup|ratesallotments|"
                       r"calendar|terms|privacy|help|faq|notice", re.I)
_GENERIC_LABELS = {"skip to main content", "skip to content", "link", "take action", "learn more", "take me there"}
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE = re.compile(r"\+?\d[\d\s().-]{8,}\d")
_LONG_ID = re.compile(r"\b[A-Z]{0,4}\d{7,}\b")
ACTIVE_FILE = config.DATA / "sources-active.json"


def check_url(platform: str, url: str) -> str | None:
    """Why this URL may not be read, or None when it may."""
    u = urllib.parse.urlparse(url or "")
    if u.scheme != "https":
        return "only https URLs"
    if u.netloc not in HOSTS:
        return f"host {u.netloc or '?'} is not a known OTA extranet"
    if HOSTS[u.netloc] != platform:
        return f"host {u.netloc} belongs to {HOSTS[u.netloc]}, not {platform}"
    text = urllib.parse.unquote(u.path + "?" + u.query + "#" + u.fragment)
    if m := DENY.search(text):
        return f"URL looks like an action or a private page ('{m.group(0)}')"
    if DENY_ANY.search(text) or set(_words(text)) & DENY_WORDS:
        return "URL looks like an action or a private page"
    return None


def _words(s: str) -> list[str]:
    return [w for w in re.split(r"[^a-z0-9]+", re.sub(r"([a-z])([A-Z])", r"\1 \2", s).lower()) if w]


def strip_session(url: str) -> str:
    """The URL without session, token, auth, language or hotel-id parameters, and without in-page anchors."""
    u = urllib.parse.urlparse(url)
    q = [(k, v) for k, v in urllib.parse.parse_qsl(u.query, keep_blank_values=True)
         if k.lower() not in SESSION_KEYS and not k.lower().startswith("auth")]
    frag = u.fragment if u.fragment.startswith("/") else ""        # keep hash routes (#/...), drop #main-content
    return urllib.parse.urlunparse(u._replace(query=urllib.parse.urlencode(q, safe=",:/"), fragment=frag))


def link_catalog(db: sqlite3.Connection, run_id: str) -> list[dict]:
    """Per platform, the back-office links seen on the pages this run already read (hrefs only, nothing clicked):
    allowed hosts, no action or private pages, session parameters removed, deduplicated, at most MAX_LINKS.
    Shared with the agent as the fixed page "<platform>/links" so it picks real pages instead of guessing URLs."""
    pages = []
    rows = db.execute("SELECT cid, slug, links_path FROM snapshots WHERE run_id=? AND links_path IS NOT NULL ORDER BY cid, slug",
                      (run_id,)).fetchall()
    by_cid: dict[str, dict[str, str]] = {}
    for cid, page_slug, path in rows:
        if not path or not Path(path).exists():
            continue
        try:
            links = json.loads(Path(path).read_text())
        except ValueError:
            continue
        if cid not in LINK_PLATFORMS:
            continue
        seen = by_cid.setdefault(cid, {})
        for link in links if isinstance(links, list) else []:
            href = str(link.get("href") or "")
            if len(seen) >= MAX_LINKS or check_url(cid, href):
                continue
            url = strip_session(href)
            u = urllib.parse.urlparse(url)
            where = urllib.parse.unquote(u.path + "?" + u.query + "#" + u.fragment)
            if url in seen or check_url(cid, url) or LINK_DENY.search(where) or not LINK_ALLOW.search(u.path + "#" + u.fragment):
                continue
            label = " ".join(str(link.get("text") or "").split())[:80]
            label = _LONG_ID.sub("[id]", _PHONE.sub("[phone]", _EMAIL.sub("[email]", label)))
            if label.lower() in _GENERIC_LABELS or not label or label.isdigit():
                label = u.path.rstrip("/").rsplit("/", 1)[-1] or url
            seen[url] = label
    for cid, links in by_cid.items():
        lines = []
        for url, label in links.items():
            fixed = fixed_page(cid, url)
            lines.append(f"{label}\t{url}" + (f"\t[已每天采集: {fixed}]" if fixed else ""))
        text = "\n".join(lines).encode()[:SAMPLE_MAX].decode(errors="ignore")
        if text:
            pages.append({"slug": f"{cid}/links", "url": next(iter(links)), "title": f"{cid} 后台可读分析页面链接（{len(links)} 个）",
                          "sample_text": text})
    return pages


def template(url: str) -> str:
    """Booking URLs carry a session token and the hotel id; read them with placeholders the run fills."""
    u = urllib.parse.urlparse(url)
    if u.netloc != "admin.booking.com":
        return url
    q = [(k, v) for k, v in urllib.parse.parse_qsl(u.query) if k not in ("ses", "hotel_id", "lang", "t")]
    rest = urllib.parse.urlencode(q, safe=",:")
    return f"https://{u.netloc}{u.path}?hotel_id={{hotel_id}}&lang=en&ses={{ses}}" + (f"&{rest}" if rest else "")


_SESSION_Q = ("ses", "hotel_id", "lang", "t")


def _page_key(url: str) -> tuple[str, str, frozenset]:
    """Host, path and the query apart from session parameters and template placeholders."""
    u = urllib.parse.urlparse(url)
    q = frozenset((k, v) for k, v in urllib.parse.parse_qsl(u.query) if k not in _SESSION_Q and "{" not in v)
    return u.netloc, u.path.rstrip("/"), q


def fixed_page(platform: str, url: str) -> str | None:
    """'cid/slug' of the collector's own page that this URL duplicates, or None."""
    from .platforms import PLATFORMS
    key = _page_key(url)
    for p in PLATFORMS:
        if p.cid != platform:
            continue
        for page in p.pages:
            if page.url.startswith("http") and _page_key(page.url) == key:
                return f"{p.cid}/{page.slug}"
    return None


def redact(url: str) -> str:
    return re.sub(r"((?:ses|token|sid|session)=)[^&#]*", r"\1REDACTED", url or "")


def sanitize(text: str) -> tuple[str | None, str]:
    """(sample, reason). None when the page reads like a guest list; otherwise identifiers are masked."""
    if len(GUEST_MARKERS.findall(text)) >= 2:
        return None, "page lists guests or reservations"
    out = _LONG_ID.sub("[id]", _PHONE.sub("[phone]", _EMAIL.sub("[email]", text)))
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.encode()[:SAMPLE_MAX].decode(errors="ignore"), ""


def metrics_of(source: dict) -> tuple[Metric, ...]:
    """The agent's catalog as Metrics; keys must be snake_case, at most 30 per page."""
    out = []
    for m in (source.get("catalog") or [])[:30]:
        key = str(m.get("key", ""))
        if not re.fullmatch(r"[a-z][a-z0-9_]{1,40}", key):
            continue
        out.append(Metric(key, str(m.get("label") or key)[:60], str(m.get("unit") or "")[:12],
                          str(m.get("period") or "")[:40], str(m.get("hint") or m.get("label") or key)[:300]))
    return tuple(out)


def slug(source: dict) -> str:
    return f"src-{int(source['id'])}"


def probe_candidates(sources: list[dict]) -> list[dict]:
    """Approved sources whose URL passes the local checks (the Worker already applied the mode)."""
    return [s for s in sources if s.get("status") == "approved" and not check_url(s.get("platform", ""), s.get("url", ""))]


def active(sources: list[dict]) -> list[dict]:
    """Active sources with a valid URL and catalog, at most MAX_ACTIVE, oldest first."""
    ok = [s for s in sources if s.get("status") == "active" and metrics_of(s)
          and not check_url(s.get("platform", ""), s.get("url", ""))]
    return sorted(ok, key=lambda s: int(s["id"]))[:MAX_ACTIVE]


def save_active(sources: list[dict]) -> None:
    """Remember today's active sources, so extraction after the browser run uses the same catalog."""
    ACTIVE_FILE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    ACTIVE_FILE.write_text(json.dumps(active(sources), ensure_ascii=False))
    os.chmod(ACTIVE_FILE, 0o600)


def catalog_for(cid: str, page_slug: str) -> tuple[Metric, ...]:
    if not page_slug.startswith("src-") or not ACTIVE_FILE.exists():
        return ()
    for s in json.loads(ACTIVE_FILE.read_text()):
        if s.get("platform") == cid and slug(s) == page_slug:
            return metrics_of(s)
    return ()


# --- cockpit ingest calls (Bearer OTA_INGEST_TOKEN) ---

def _call(path: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(config.COCKPIT_URL + path, data=data, method="GET" if body is None else "POST",
                                 headers={"Authorization": f"Bearer {os.environ['OTA_INGEST_TOKEN']}",
                                          "Content-Type": "application/json", "User-Agent": "wgpk-ota-insights/0.1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def fetch() -> list[dict]:
    """Approved (to probe) and active (to read daily) sources; the Worker re-validates their URLs."""
    return _call("/api/ingest/sources").get("sources") or []


def post_probe(source_id: int, ok: bool, final_url: str = "", title: str = "", sample_text: str = "",
               reason: str = "") -> dict:
    return _call(f"/api/ingest/sources/{int(source_id)}/probe", {
        "ok": ok, "final_url": redact(final_url), "title": title[:200], "sample_text": sample_text, "reason": reason[:300]})


def builtin_pages(db: sqlite3.Connection, run_id: str) -> list[dict]:
    """Sanitized text of the fixed analysis pages read in this run."""
    pages = []
    for cid, page_slug in BUILTIN:
        row = db.execute("SELECT url, title, text_path FROM snapshots WHERE run_id=? AND cid=? AND slug=? AND status='ok'",
                         (run_id, cid, page_slug)).fetchone()
        if not row or not row[2] or not Path(row[2]).exists():
            continue
        sample, _ = sanitize(Path(row[2]).read_text())
        if sample:
            pages.append({"slug": f"{cid}/{page_slug}", "url": redact(row[0]), "title": (row[1] or "")[:200],
                          "sample_text": sample})
    return pages


def post_builtin(db: sqlite3.Connection, run_id: str) -> dict:
    pages = builtin_pages(db, run_id) + link_catalog(db, run_id)
    return _call("/api/ingest/sources/builtin", {"pages": pages}) if pages else {"ok": True, "pages": 0}


# --- local bookkeeping of probes (the daily cap survives restarts) ---

def probes_today(db: sqlite3.Connection, day: str) -> int:
    db.execute("CREATE TABLE IF NOT EXISTS source_probes (at TEXT NOT NULL, source_id INTEGER, outcome TEXT)")
    return db.execute("SELECT count(*) FROM source_probes WHERE at LIKE ? AND outcome != 'duplicate'", (day + "%",)).fetchone()[0]


def record_probe(db: sqlite3.Connection, at: str, source_id: int, outcome: str) -> None:
    probes_today(db, at[:10])
    db.execute("INSERT INTO source_probes VALUES (?, ?, ?)", (at, source_id, outcome))
    db.commit()
