from app.domains.polymarket_auto_live.engine import (
    _derive_stage2_actionable_market_id_orders,
    _filter_stage2_actionable_market_id_order,
    _normalize_stage2_actionable_market_id_order,
    _stage2_actionable_hold_position_keys,
)
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveConsoleRunContext


class _Position:
    def __init__(self, market_id: str, side: str) -> None:
        self.market_id = market_id
        self.side = side


def test_console_context_normalizes_stage2_actionable_market_ids() -> None:
    context = BullpenAutoLiveConsoleRunContext(
        stage2_actionable_exit_market_ids=[" exit-1 ", "exit-1", "", None],
        stage2_actionable_buy_market_ids=["buy-2", " buy-1 ", "buy-2"],
    )

    assert context.stage2_actionable_exit_market_ids == ["exit-1"]
    assert context.stage2_actionable_buy_market_ids == ["buy-2", "buy-1"]


def test_actionable_handoff_preserves_order_and_reports_missing_rows() -> None:
    requested = _normalize_stage2_actionable_market_id_order(
        ["buy-3", "buy-1", "buy-3", "buy-missing"]
    )
    accepted, missing = _filter_stage2_actionable_market_id_order(
        requested,
        {"buy-1", "buy-2", "buy-3"},
    )

    assert accepted == ["buy-3", "buy-1"]
    assert missing == ["buy-missing"]


def test_actionable_exit_handoff_holds_every_non_exit_position() -> None:
    positions = [
        _Position("hold-1", "YES"),
        _Position("exit-1", "NO"),
        _Position("hold-2", "NO"),
    ]

    assert _stage2_actionable_hold_position_keys(positions, {"exit-1"}) == {
        "hold-1::YES",
        "hold-2::NO",
    }

def test_full_run_derives_exact_exit_and_buy_actionable_order() -> None:
    positions = [
        _Position("hold-1", "YES"),
        _Position("exit-1", "NO"),
        _Position("exit-2", "YES"),
        _Position("hold-2", "NO"),
    ]

    exits, buys = _derive_stage2_actionable_market_id_orders(
        positions,
        {"hold-1::YES", "hold-2::NO"},
        ["buy-3", "buy-1", "buy-3"],
    )

    assert exits == ["exit-1", "exit-2"]
    assert buys == ["buy-3", "buy-1"]


def test_full_run_source_persists_actionables_and_stage3_queue_counts() -> None:
    from pathlib import Path
    import app.domains.polymarket_auto_live.engine as engine

    source = Path(engine.__file__).read_text(encoding="utf-8")

    assert '"stage2_actionable_handoff_source"' in source
    assert '"stage2_actionable_exit_count"' in source
    assert '"stage2_actionable_buy_count"' in source
    assert "initial_stage3_execution_steps" in source
    assert "initial_stage3_planned_exit_count" in source
    assert "initial_stage3_planned_buy_count" in source
    assert "async def recover_stage1_wallet_snapshot" in source
