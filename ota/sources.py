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
    if m := DENY.search(urllib.parse.unquote(u.path + "?" + u.query)):
        return f"URL looks like an action or a private page ('{m.group(0)}')"
    return None


def template(url: str) -> str:
    """Booking URLs carry a session token and the hotel id; read them with placeholders the run fills."""
    u = urllib.parse.urlparse(url)
    if u.netloc != "admin.booking.com":
        return url
    q = [(k, v) for k, v in urllib.parse.parse_qsl(u.query) if k not in ("ses", "hotel_id", "lang", "t")]
    rest = urllib.parse.urlencode(q, safe=",:")
    return f"https://{u.netloc}{u.path}?hotel_id={{hotel_id}}&lang=en&ses={{ses}}" + (f"&{rest}" if rest else "")


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
    pages = builtin_pages(db, run_id)
    return _call("/api/ingest/sources/builtin", {"pages": pages}) if pages else {"ok": True, "pages": 0}


# --- local bookkeeping of probes (the daily cap survives restarts) ---

def probes_today(db: sqlite3.Connection, day: str) -> int:
    db.execute("CREATE TABLE IF NOT EXISTS source_probes (at TEXT NOT NULL, source_id INTEGER, outcome TEXT)")
    return db.execute("SELECT count(*) FROM source_probes WHERE at LIKE ?", (day + "%",)).fetchone()[0]


def record_probe(db: sqlite3.Connection, at: str, source_id: int, outcome: str) -> None:
    probes_today(db, at[:10])
    db.execute("INSERT INTO source_probes VALUES (?, ?, ?)", (at, source_id, outcome))
    db.commit()
