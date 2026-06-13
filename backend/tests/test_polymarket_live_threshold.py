from types import SimpleNamespace

from app.domains.polymarket.bullpen import LiveTradeGuard
from app.domains.polymarket.schemas import PolymarketSourceTrade


def _guard(threshold: float = 500) -> LiveTradeGuard:
    return LiveTradeGuard(
        SimpleNamespace(
            max_live_trades_per_day=10,
            trader_invested_threshold_usd=threshold,
            max_live_daily_loss=10,
            fixed_copy_trade_size=1,
            max_live_trade_size=1,
            max_live_exposure_per_market=5,
        )
    )


def _source_trade(
    size_usd: float, trader_invested_usd: float | None = None
) -> PolymarketSourceTrade:
    return PolymarketSourceTrade(
        id=f"trade-{size_usd}",
        source_trade_key=f"source-{size_usd}",
        trader_id="trader-1",
        trader_name="Trader One",
        trader_address="0xabc",
        clean_trader_identity="0xabc",
        market_id="market-1",
        market_title="Test market",
        outcome="Yes",
        side="BUY",
        price=0.5,
        size_usd=size_usd,
        trader_invested_usd=trader_invested_usd,
        timestamp="2026-06-13T00:00:00Z",
        source="live-market-read",
    )


def test_live_guard_rejects_trades_at_or_below_trader_invested_threshold():
    assert (
        _guard().trade_block_reason(_source_trade(500), [], [])
        == "Below $500 threshold"
    )
    assert (
        _guard().trade_block_reason(_source_trade(329.99), [], [])
        == "Below $500 threshold"
    )


def test_live_guard_allows_trades_above_trader_invested_threshold():
    assert _guard().trade_block_reason(_source_trade(500.01), [], []) is None


def test_live_guard_uses_aggregate_trader_invested_when_available():
    assert (
        _guard(threshold=100).trade_block_reason(
            _source_trade(1, trader_invested_usd=270.28), [], []
        )
        is None
    )
    assert (
        _guard(threshold=100).trade_block_reason(
            _source_trade(270.28, trader_invested_usd=1), [], []
        )
        == "Below $100 threshold"
    )
