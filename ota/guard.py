"""Run guards: the review operator's lock and its schedule windows.

A collection runs only when (1) no review run is in progress and (2) no review window is near.
While it runs it holds the operator's own lock, so the review operator cannot start on the same
Chrome mid-collection. The price: a reply Gary approves during those few minutes is published at
the next review run instead of immediately (the operator re-reads approvals every run).
"""
from __future__ import annotations

import datetime as dt
import fcntl
import os
from pathlib import Path


class Busy(Exception):
    """The review operator is running, or one of its windows is too close."""


def near_review_window(now: dt.datetime, slots: list[str], margin_min: int) -> str | None:
    """The slot within margin_min minutes of now (either side), or None."""
    for s in slots:
        h, m = (int(x) for x in s.split(":"))
        for day in (-1, 0, 1):
            at = now.replace(hour=h, minute=m, second=0, microsecond=0) + dt.timedelta(days=day)
            if abs((at - now).total_seconds()) <= margin_min * 60:
                return s
    return None


def take_operator_lock(path: Path) -> int:
    """Non-blocking exclusive flock on the operator's lock file; raises Busy when it is held.

    The fd must stay open for the whole collection; closing it releases the lock.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise Busy(f"review operator holds {path}") from None
    return fd


def release(fd: int) -> None:
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)
