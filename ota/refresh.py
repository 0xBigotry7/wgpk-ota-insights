"""On-demand re-collection the ota agent asks for (cockpit refresh.js; Gary 2026-10-29).

The agent queues a refresh of one or more platforms in the cockpit; the collector serves it at its next launchd slot
once the day's full collection is done, with the same guards as every run (review windows, the operator's lock, the
operator's Chrome, read-only pages). The Worker allows one refresh a day. A full run that finishes while a request
waits covers it. The cockpit being down never stops a run.
"""
from __future__ import annotations

from .platforms import PLATFORMS
from .sources import _call

KNOWN = {p.cid for p in PLATFORMS}


def claim() -> dict | None:
    """The waiting request, now marked running, or None. Unknown platforms are dropped here as well."""
    try:
        req = _call("/api/ingest/refresh/next").get("request")
    except Exception as e:  # noqa: BLE001
        print(f"refresh queue unavailable: {type(e).__name__}", flush=True)
        return None
    if not req:
        return None
    platforms = {p for p in req.get("platforms") or [] if p in KNOWN}
    if not platforms:
        report(req["id"], "failed", detail="no known platform in the request")
        return None
    return {"id": int(req["id"]), "platforms": platforms, "reason": req.get("reason", "")}


def report(request_id: int, status: str, run_id: str = "", detail: str = "") -> None:
    try:
        _call(f"/api/ingest/refresh/{int(request_id)}", {"status": status, "run_id": run_id, "detail": detail[:500]})
    except Exception as e:  # noqa: BLE001
        print(f"refresh {request_id}: report failed {type(e).__name__}", flush=True)
