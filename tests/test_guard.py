import datetime as dt
import fcntl
import os

import pytest

from ota import guard

BKK = dt.timezone(dt.timedelta(hours=7))


@pytest.mark.parametrize("hhmm,expect", [("08:20", "09:15"), ("10:10", "09:15"), ("11:30", None),
                                         ("13:50", "14:45"), ("15:40", "14:45"), ("16:00", None)])
def test_review_window_margin(hhmm, expect):
    h, m = map(int, hhmm.split(":"))
    now = dt.datetime(2026, 10, 22, h, m, tzinfo=BKK)
    assert guard.near_review_window(now, ["09:15", "14:45"], 60) == expect


def test_window_across_midnight():
    now = dt.datetime(2026, 10, 22, 23, 40, tzinfo=BKK)
    assert guard.near_review_window(now, ["00:10"], 60) == "00:10"


def test_skips_when_operator_holds_lock(tmp_path):
    lock = tmp_path / "operator.lock"
    held = os.open(lock, os.O_RDWR | os.O_CREAT)
    fcntl.flock(held, fcntl.LOCK_EX)
    try:
        with pytest.raises(guard.Busy):
            guard.take_operator_lock(lock)
    finally:
        os.close(held)


def test_holding_lock_blocks_operator_then_releases(tmp_path):
    lock = tmp_path / "operator.lock"
    fd = guard.take_operator_lock(lock)
    other = os.open(lock, os.O_RDWR)
    with pytest.raises(BlockingIOError):          # what operator_v2.run._try_lock would see
        fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
    guard.release(fd)
    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.close(other)
