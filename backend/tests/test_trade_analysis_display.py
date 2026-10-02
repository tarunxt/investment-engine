from datetime import UTC, datetime
from types import SimpleNamespace

from app.domains.bullpen_trade_analysis.service import _build_summary


def _record(*, executed=False, closed=False):
    now = datetime.now(UTC)
    return SimpleNamespace(
        buy_executed_at=now if executed else None,
        closed_at=now if closed else None,
        net_pnl=0,
        holding_period_seconds=None,
        pnl_percent=None,
        fees_total=0,
    )


def test_unexecuted_failed_or_pending_records_are_not_open_positions():
    summary = _build_summary([_record(), _record(), _record(executed=True)])
    assert summary.total_executed_trades == 1
    assert summary.open_positions == 1


def test_closed_executed_positions_are_not_counted_as_open():
    summary = _build_summary([_record(executed=True, closed=True), _record()])
    assert summary.total_executed_trades == 1
    assert summary.open_positions == 0
    assert summary.closed_positions == 1
