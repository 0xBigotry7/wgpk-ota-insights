import datetime as dt

import pytest

from ota.forecast import backtest, baseline


def rows():
    start = dt.date(2026, 1, 1)
    return [{"stay_date": (start + dt.timedelta(days=d)).isoformat(), "kind": "actual",
             "inventory": 100, "rooms_sold": 50, "room_revenue": 50000} for d in range(150)]


def test_no_future_actual_or_pms_projection_leakage():
    history = rows()
    clean = baseline(history, "2026-03-01", "2026-03-30")
    dirty = [dict(r, rooms_sold=99, room_revenue=999999) if r["stay_date"] >= "2026-03-01" else r for r in history]
    dirty += [{**history[0], "kind": "pms_projection", "stay_date": "2026-02-01", "rooms_sold": 99}]
    assert baseline(dirty, "2026-03-01", "2026-03-30") == clean
    assert clean["occupancy"] == 50
    assert clean["adr"] == 1000
    assert clean["revpar"] == 500
    assert clean["training_end"] < clean["as_of"]


def test_missing_capacity_insufficient_history_and_duplicate_scope():
    assert baseline(rows()[:7], "2026-02-01", "2026-02-02") is None
    assert baseline([dict(r, inventory=None) for r in rows()], "2026-03-01", "2026-03-02") is None
    with pytest.raises(ValueError, match="duplicate"):
        baseline(rows() + [rows()[45]], "2026-03-01", "2026-03-02")
    with pytest.raises(ValueError):
        baseline(rows(), "2026-03-01", "2026-02-01")


def test_rolling_backtest_has_zero_error_on_stationary_data_and_no_future_predictions_as_truth():
    history = rows()
    scores = backtest(history)["scores"]
    assert len(scores) == 8
    for score in scores:
        assert score["n"] >= 9
        assert score["occupancy_mae_pp"] == 0
        assert score["rooms_sold_wape_pct"] == 0
        assert score["room_revenue_wape_pct"] == 0
    assert backtest([dict(r, kind="pms_projection") for r in history])["scores"] == []
