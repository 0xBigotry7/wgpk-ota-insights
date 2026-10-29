---
name: ota-sources
description: Add a new OTA back-office page to the daily collection and define what to extract from it, when Gary asks for data you do not have yet or you find a gap. Also read the text of fixed analysis pages (Genius, competitive set, opportunities).
---

# Growing what you can see

You never open a browser. The hotel Mac mini's collector reads pages for you, read-only, in its daily window.
All calls go through the cockpit skill's `ota-api`.

1. **See what exists.** `ota-api GET /api/agent/sources` lists your sources, the mode (auto | approve), the
   allowed hosts and the limits. Fixed analysis pages (`builtin: true`) have text you can read with
   `GET /api/agent/sources/<id>/sample`. Read those before asking for a new page. Many more pages (sales,
   pace, search rank, booker insights, Agoda dashboard, Ctrip traffic…) are already read every day; their
   numbers are in `GET /api/agent/metrics?platform=…`. Check there first: a request for one of those pages
   comes back `rejected` with "already read daily as <platform/page>".
2. **Request a page.** Never guess a URL (a guessed one usually comes back 404). Pick it from the link catalog:
   the fixed pages `booking/links`, `agoda/links`, `expedia/links`, `ctrip/links` in `GET /api/agent/sources`
   (read their sample: one line per page, `label<TAB>url`, marked `[已每天采集: …]` when the collector already reads
   it daily — don't request those). The catalog is refreshed from the pages read each day and holds analysis pages
   only. If the page you need is not in it, ask Gary for the link. Then:
   `ota-api POST /api/agent/sources '{"platform":"booking","url":"https://admin.booking.com/…","why":"which decision this serves"}'`
   Only Booking, Agoda, Ctrip, Expedia and Medallia back-office hosts. Pages that act (save, update, cancel,
   reply, payment…) or hold guest messages or reviews are refused by the server; do not try to get around it.
   At most 3 new requests a day and 10 active sources.
3. **Tell Gary** in one Telegram line right after a request: which page, why, and that it is read on the next
   collection. In approve mode, ask him to approve it instead.
4. **Read the probe.** After the next collection, `GET /api/agent/sources/<id>/sample` has the page text
   (status `probed`), or the source is `rejected` with a reason (signed out, error page, guest data).
5. **Define the catalog.** Pick only numbers that are on the page next to a stable label:
   `ota-api POST /api/agent/sources/<id>/catalog '{"metrics":[{"key":"booking_cancel_rate","label":"取消率","unit":"%","period":"last_30_days","hint":"Cancellation rate","peer":false}]}'`
   Keys: lower_snake_case, prefixed with the platform, never reusing fixed keys (`pace_`, `pickup_`, `otb_`,
   `stayed_`). From the next 10:20 collection these numbers arrive daily; query them with
   `GET /api/agent/metrics?metric_prefix=booking_cancel_`.
6. **Fix or retire.** If a number comes back wrong or missing, post the catalog again with a better hint. If a
   source stops being useful: `POST /api/agent/sources/<id>/status '{"status":"retired","reason":"…"}'`.
7. **Stricter on request.** If Gary says every new page needs his OK:
   `POST /api/agent/sources/mode '{"mode":"approve"}'`. You cannot switch back to auto yourself.

Write what you learned about a page (what it shows, which numbers matter) as a note, topic `数据源`.
