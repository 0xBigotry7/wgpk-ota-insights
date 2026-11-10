"""Archive Lighthouse XLSX reports from the lighthouse-reports@ inbox API, an IMAP inbox or local fixtures.

The hotel address lighthouse-reports@wyndhamgardenkamala.com is a Cloudflare Email Routing alias (no IMAP):
the Worker wgpk-lighthouse-email-ingest (wgpk-concierge/infra/lighthouse-email-worker) checks the sender
(allowed domain + Cloudflare DMARC/DKIM verdict), archives the mail and serves it read-only at
LIGHTHOUSE_INBOX_URL. The Worker itself parses each report (a JS port of parse_xlsx) and pushes the agent views to
the cockpit, so nothing polls. --poll-inbox here is a manual backfill / cross-check of that port.
"""

import argparse
import hashlib
import imaplib
import io
import json
import os
import re
import sqlite3
import ssl
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta
from email import policy
from email.parser import BytesParser
from email.utils import parseaddr
from pathlib import Path
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

PROPERTY = "Wyndham Garden Phuket Kamala"
INBOX_URL = os.environ.get("LIGHTHOUSE_INBOX_URL", "https://lighthouse-inbox.wyndhamgardenkamala.com")
INBOX_TOKEN_FILE = Path(
    os.environ.get("LIGHTHOUSE_INBOX_TOKEN_FILE", Path.home() / ".config" / "wgpk" / "lighthouse_inbox_token")
)
LIVE_ORIGINS = ("imap", "inbox_api")  # manual samples never count as live snapshots
LIMIT = 24 * 1024 * 1024


def parse_xlsx(raw):
    if not 0 < len(raw) <= LIMIT:
        raise ValueError("invalid attachment size")
    with ZipFile(io.BytesIO(raw)) as z:
        if sum(f.file_size for f in z.infolist()) > 4 * LIMIT:
            raise ValueError("expanded workbook too large")

        def xml(path):
            return ElementTree.fromstring(z.read(path))

        strings = (
            ["".join(n.text or "" for n in s.findall(".//{*}t")) for s in xml("xl/sharedStrings.xml")]
            if "xl/sharedStrings.xml" in z.namelist()
            else []
        )
        relations = {r.attrib["Id"]: r.attrib["Target"] for r in xml("xl/_rels/workbook.xml.rels")}
        sheets = {}
        for sheet in xml("xl/workbook.xml").findall(".//{*}sheet"):
            rel = next(v for k, v in sheet.attrib.items() if k.endswith("}id"))
            target = relations[rel]
            rows = []
            for row in xml(target.lstrip("/") if target.startswith("/") else "xl/" + target).findall(
                ".//{*}row"
            ):
                cells = {}
                for c in row.findall("{*}c"):
                    column = re.sub(r"\d", "", c.attrib["r"])
                    value = c.findtext("{*}v")
                    kind = c.get("t")
                    if kind == "s":
                        value = strings[int(value)]
                    elif kind == "inlineStr":
                        value = "".join(t.text or "" for t in c.findall(".//{*}t"))
                    elif kind in (None, "n") and value is not None:
                        value = float(value)
                    cells[column] = value
                rows.append(cells)
            sheets[sheet.attrib["name"]] = rows

    def table(rows, header_index, required):
        headers = {k: v for k, v in rows[header_index].items() if isinstance(v, str) and v}
        if not set(required).issubset(headers.values()) or len(headers) != len(set(headers.values())):
            raise ValueError("workbook headers changed")
        return [
            {name: row.get(column) for column, name in headers.items()}
            for row in rows[header_index + 1 :]
            if any(row.get(k) is not None for k in headers)
        ]

    if {"Daily details", "Geo breakdown", "Stay pattern breakdown"} == set(sheets):
        day = sheets["Daily details"]
        if day[0].get("D") != f"Market Insight - {PROPERTY} - THB":
            raise ValueError("unexpected property or currency")
        daily = table(day, 4, ("Date", "Demand level", "My price", "My OTB", "Market OTB"))
        dates = []
        for row in daily:
            serial = row["Date"]
            if not isinstance(serial, float) or not serial.is_integer() or not 40000 <= serial <= 80000:
                raise ValueError("invalid stay date")
            row["Date"] = (datetime(1899, 12, 30) + timedelta(days=serial)).date().isoformat()
            dates.append(row["Date"])
            for field in ("My OTB", "Market OTB", "Unavailable hotels"):
                if not isinstance(row.get(field), (int, float)) or not 0 <= row[field] <= 1:
                    row[field] = None
        if not dates or dates != sorted(set(dates)):
            raise ValueError("duplicate, missing or unordered stay dates")
        return "market", {
            "property": PROPERTY,
            "currency": "THB",
            "daily": daily,
            "geo": table(sheets["Geo breakdown"], 4, ("Top 10 countries searching for hotels",)),
            "stay_patterns": table(sheets["Stay pattern breakdown"], 4, ("LOS bucket",)),
        }
    if "Events by date" in sheets and len(sheets) == 2:
        raw_events = next(
            rows for name, rows in sheets.items() if name.startswith("Events ") and name != "Events by date"
        )
        events = table(raw_events, 0, ("Start date", "End date", "Name", "Category", "Accepted event"))
        events = [
            r
            for r in events
            if not (
                r["Name"] is None
                and str(r["Start date"]).startswith(("Powered by PredictHQ", "https://signup.predicthq.com/"))
            )
        ]
        for row in events:
            for field in ("Start date", "End date"):
                row[field] = datetime.strptime(row[field], "%d/%m/%Y").date().isoformat()
        return "events", {"events": events, "property_in_file": None}
    raise ValueError("not a supported Lighthouse workbook")


def archive(db, raw, observed_at, origin):
    kind, data = parse_xlsx(raw)
    digest = hashlib.sha256(raw).hexdigest()
    payload = json.dumps(data, sort_keys=True, allow_nan=False)
    data_hash = hashlib.sha256(payload.encode()).hexdigest()
    with db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS lighthouse_snapshots (sha256 TEXT PRIMARY KEY, kind TEXT NOT NULL,"
            " observed_at TEXT NOT NULL, origin TEXT NOT NULL, data_hash TEXT NOT NULL,"
            " payload TEXT NOT NULL, original BLOB NOT NULL)"
        )
        cursor = db.execute(
            "INSERT OR IGNORE INTO lighthouse_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)",
            (digest, kind, observed_at, origin, data_hash, payload, raw),
        )
    return {"kind": kind, "sha256": digest, "data_hash": data_hash, "inserted": bool(cursor.rowcount)}


def poll(db, since_days):
    host = os.environ["LIGHTHOUSE_IMAP_HOST"]
    user = os.environ["LIGHTHOUSE_IMAP_USER"]
    password = os.environ["LIGHTHOUSE_IMAP_PASSWORD"]
    allowed = {v.strip().lower() for v in os.environ["LIGHTHOUSE_ALLOWED_SENDERS"].split(",") if v.strip()}
    if not allowed or any(not re.fullmatch(r"[^@\s]+@[^@\s]+", sender) for sender in allowed):
        raise ValueError("configure exact, authenticated sender addresses")
    with imaplib.IMAP4_SSL(host, ssl_context=ssl.create_default_context(), timeout=30) as inbox:
        inbox.login(user, password)
        status, _ = inbox.select("INBOX", readonly=True)
        if status != "OK":
            raise RuntimeError("could not select dedicated inbox")
        cutoff = (datetime.now(UTC) - timedelta(days=since_days)).strftime("%d-%b-%Y")
        status, result = inbox.uid("search", None, "SINCE", cutoff)
        if status != "OK":
            raise RuntimeError("mail search failed")
        for uid in result[0].split():
            status, size_result = inbox.uid("fetch", uid, "(RFC822.SIZE)")
            size = re.search(rb"RFC822.SIZE (\d+)", size_result[0] or b"")
            if status != "OK" or not size:
                raise RuntimeError("mail size lookup failed")
            if int(size[1]) > 2 * LIMIT:
                continue
            status, result = inbox.uid("fetch", uid, "(INTERNALDATE BODY.PEEK[])")
            if status != "OK":
                raise RuntimeError("mail fetch failed")
            for item in result:
                if not isinstance(item, tuple):
                    continue
                date = re.search(rb'INTERNALDATE "([^"]+)"', item[0])
                if not date:
                    raise RuntimeError("missing trusted mailbox receipt time")
                observed = datetime.strptime(date[1].decode().strip(), "%d-%b-%Y %H:%M:%S %z").astimezone(UTC)
                mail = BytesParser(policy=policy.default).parsebytes(item[1])
                if parseaddr(str(mail.get("From", "")))[1].lower() not in allowed:
                    continue
                for part in mail.iter_attachments():
                    if (part.get_filename() or "").lower().endswith(".xlsx"):
                        try:
                            print(
                                json.dumps(
                                    archive(db, part.get_payload(decode=True), observed.isoformat(), "imap")
                                )
                            )
                        except (
                            BadZipFile,
                            ValueError,
                            KeyError,
                            IndexError,
                            TypeError,
                            ElementTree.ParseError,
                        ) as exc:
                            print(json.dumps({"status": "rejected", "uid": uid.decode(), "reason": str(exc)}))


def _inbox_get(path, token):
    req = urllib.request.Request(
        INBOX_URL + path,
        headers={"Authorization": f"Bearer {token}", "User-Agent": "wgpk-ota-insights/lighthouse"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def poll_inbox(db):
    """Archive new .xlsx attachments from the inbox API; returns how many snapshots were new."""
    token = INBOX_TOKEN_FILE.read_text().strip()
    if not token:
        raise ValueError(f"empty inbox token in {INBOX_TOKEN_FILE}")
    with db:
        db.execute("CREATE TABLE IF NOT EXISTS lighthouse_inbox_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), since TEXT)")
    row = db.execute("SELECT since FROM lighthouse_inbox_cursor WHERE id = 1").fetchone()
    since, inserted = (row[0] if row else "") or "", 0
    while True:
        query = urllib.parse.urlencode({"since": since, "limit": 50})
        page = json.loads(_inbox_get(f"/api/messages?{query}", token))
        for message in page["messages"]:
            for att in message["attachments"]:
                if att["duplicate_of"] or not att["filename"].lower().endswith(".xlsx") or att["bytes"] > LIMIT:
                    continue
                raw = _inbox_get(att["url"], token)
                if hashlib.sha256(raw).hexdigest() != att["sha256"]:
                    raise RuntimeError(f"checksum mismatch for attachment {att['id']}")
                try:
                    result = archive(db, raw, message["received_at"], "inbox_api")
                except (BadZipFile, ValueError, KeyError, IndexError, TypeError, ElementTree.ParseError) as exc:
                    result = {"status": "rejected", "attachment": att["id"], "reason": str(exc)}
                inserted += bool(result.get("inserted"))
                print(json.dumps({"message": message["id"][:12], "filename": att["filename"], **result}))
        since = page["next_since"] or since
        with db:
            db.execute(
                "INSERT INTO lighthouse_inbox_cursor (id, since) VALUES (1, ?) "
                "ON CONFLICT(id) DO UPDATE SET since = excluded.since",
                (since,),
            )
        if not page["has_more"]:
            return inserted


def latest(db, kind):
    marks = ",".join("?" * len(LIVE_ORIGINS))
    row = db.execute(
        "SELECT observed_at, sha256, data_hash, payload FROM lighthouse_snapshots "
        f"WHERE kind=? AND origin IN ({marks}) ORDER BY observed_at DESC LIMIT 1",
        (kind, *LIVE_ORIGINS),
    ).fetchone()
    if row is None:
        return None
    return {"received_at": row[0], "sha256": row[1], "data_hash": row[2], **json.loads(row[3])}


def compare_market(db):
    marks = ",".join("?" * len(LIVE_ORIGINS))
    snapshots = db.execute(
        "SELECT observed_at, payload FROM lighthouse_snapshots WHERE kind='market' "
        f"AND origin IN ({marks}) ORDER BY observed_at DESC LIMIT 2",
        LIVE_ORIGINS,
    ).fetchall()
    if len(snapshots) != 2 or snapshots[0][0] == snapshots[1][0]:
        return None
    (current_at, current), (prior_at, prior) = snapshots
    older = {r["Date"]: r for r in json.loads(prior)["daily"]}
    changes = []
    for row in json.loads(current)["daily"]:
        previous = older.get(row["Date"])
        if previous is None:
            continue
        entry = {"stay_date": row["Date"]}
        for metric in ("My price", "My OTB", "Market OTB"):
            a, b = row.get(metric), previous.get(metric)
            entry[metric] = (
                round(a - b, 4) if isinstance(a, (int, float)) and isinstance(b, (int, float)) else None
            )
        entry["demand_before"] = previous["Demand level"]
        entry["demand_after"] = row["Demand level"]
        changes.append(entry)
    return {"current_received_at": current_at, "prior_received_at": prior_at, "changes": changes}


def push_cockpit(db):
    """Send the three agent views to the cockpit (Bearer OTA_INGEST_TOKEN); missing views are sent as null."""
    from . import cockpit, config

    config.load_env()
    views = {"market": latest(db, "market"), "events": latest(db, "events"), "compare_market": compare_market(db)}
    return cockpit.post("/api/ingest/lighthouse", {"generated_at": datetime.now(UTC).isoformat(), "views": views})


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--db", type=Path, required=True)
    group = cli.add_mutually_exclusive_group(required=True)
    group.add_argument("--sample", type=Path, nargs="+")
    group.add_argument("--poll", action="store_true")
    group.add_argument("--poll-inbox", action="store_true", help="read the lighthouse-reports@ inbox API")
    group.add_argument("--latest", choices=["market", "events"])
    group.add_argument("--compare-market", action="store_true")
    cli.add_argument("--since-days", type=int, choices=range(1, 31), default=3)
    cli.add_argument("--push-cockpit", action="store_true", help="after --poll-inbox, send the agent views when new")
    args = cli.parse_args()
    os.umask(0o077)
    with sqlite3.connect(args.db) as db:
        if args.sample:
            for path in args.sample:
                observed = datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat()
                print(json.dumps(archive(db, path.read_bytes(), observed, "local_sample")))
        elif args.poll:
            poll(db, args.since_days)
        elif args.poll_inbox:
            inserted = poll_inbox(db)
            if args.push_cockpit and inserted:
                print(json.dumps({"cockpit": push_cockpit(db)}))
        elif args.compare_market:
            out = compare_market(db)
            if out is None:
                cli.exit(2, "Need two live Lighthouse snapshots with distinct receipt times\n")
            print(json.dumps(out))
        else:
            out = latest(db, args.latest)
            if out is None:
                cli.exit(2, "No live Lighthouse snapshot yet\n")
            print(json.dumps(out))


if __name__ == "__main__":
    main()
