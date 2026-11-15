from app.domains.polymarket.bot import PolymarketPaperCopyBot
from app.domains.polymarket.schemas import PolymarketPosition, PolymarketSourceTrade


def _source_trade(market_id: str, outcome: str, price: float) -> PolymarketSourceTrade:
    return PolymarketSourceTrade(
        id=f"trade-{market_id}-{outcome}-{price}",
        source_trade_key=f"key-{market_id}-{outcome}-{price}",
        trader_id="trader-1",
        trader_name="Trader",
        trader_address="0xabc",
        clean_trader_identity="0xabc",
        market_id=market_id,
        market_title="ITF Hurghada: Polina Iatcenko vs Anastasia Tikhonova",
        outcome=outcome,
        side="BUY",
        price=price,
        size_usd=10,
        timestamp="2026-06-13T00:00:00+00:00",
        source="live-read",
    )


def _position() -> PolymarketPosition:
    return PolymarketPosition(
        key="market-1::Polina Iatcenko",
        market_id="market-1",
        market_title="ITF Hurghada: Polina Iatcenko vs Anastasia Tikhonova",
        outcome="Polina Iatcenko",
        shares=8.625,
        average_price=0.348,
        cost_basis=3.0,
    )


def test_favorable_auto_exit_triggers_at_held_outcome_99_9_cents():
    bot = PolymarketPaperCopyBot.__new__(PolymarketPaperCopyBot)
    prices = bot._latest_live_prices_by_market_outcome(
        [_source_trade("market-1", "Polina Iatcenko", 0.999)]
    )

    assert bot._favorable_exit_price(_position(), prices) == 0.999


def test_favorable_auto_exit_triggers_when_opposite_outcome_is_0_1_cents():
    bot = PolymarketPaperCopyBot.__new__(PolymarketPaperCopyBot)
    prices = bot._latest_live_prices_by_market_outcome(
        [_source_trade("market-1", "Anastasia Tikhonova", 0.001)]
    )

    assert bot._favorable_exit_price(_position(), prices) == 0.999


def test_auto_exit_decision_sells_full_live_position():
    bot = PolymarketPaperCopyBot.__new__(PolymarketPaperCopyBot)
    decision = bot._auto_exit_decision(_position(), 0.999)

    assert decision.side == "SELL"
    assert decision.command == "sell"
    assert decision.market_title == "ITF Hurghada: Polina Iatcenko vs Anastasia Tikhonova"
    assert decision.outcome == "Polina Iatcenko"
    assert decision.shares == 8.625
    assert decision.amount == 8.625 * 0.999
    assert "99.9¢" in decision.reason
    assert "0.1¢" in decision.reason
