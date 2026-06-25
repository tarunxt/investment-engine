from app.domains.polymarket.schemas import PolymarketUserConfigOverride
from app.domains.polymarket_direct.schemas import (
    PolymarketUserConfigOverride as DirectPolymarketUserConfigOverride,
)


def test_polymarket_user_config_override_allows_empty_legacy_payload():
    override = PolymarketUserConfigOverride.model_validate({})

    assert override.max_live_trades_per_day is None
    assert override.trader_invested_threshold_usd is None
    assert override.max_live_exposure_per_market is None
    assert override.auto_start is None
    assert override.paused is None


def test_direct_polymarket_user_config_override_allows_empty_legacy_payload():
    override = DirectPolymarketUserConfigOverride.model_validate({})

    assert override.max_live_trades_per_day is None
    assert override.trader_invested_threshold_usd is None
    assert override.max_live_exposure_per_market is None
