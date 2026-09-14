from datetime import UTC, datetime, timedelta

from app.domains.polymarket_auto_live.console_profile import (
    console_market_filter_reasons,
)
from app.domains.polymarket_auto_live.router import (
    _effective_filter_profile_settings,
)
from app.domains.polymarket_auto_live.scanner import ScannedMarket
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveSettings


def test_sports_profile_defaults_to_shared_full_universe_with_sports_included() -> None:
    settings = BullpenAutoLiveSettings()

    effective = _effective_filter_profile_settings(settings, "bullpen-sports")

    assert effective.console_scan_scope == "full_universe"
    assert effective.console_exclude_sports is False
    assert effective.console_sports_moneyline_only is True
    assert settings.console_exclude_sports is True
    assert settings.console_sports_moneyline_only is False


def test_sports_profile_overlay_does_not_mutate_bullpen007_settings() -> None:
    settings = BullpenAutoLiveSettings(
        console_min_volume_usd=100,
        console_filter_profiles={
            "bullpen-sports": {"console_min_volume_usd": 2500}
        },
    )

    effective = _effective_filter_profile_settings(settings, "bullpen-sports")

    assert effective.console_min_volume_usd == 2500
    assert settings.console_min_volume_usd == 100


def _sports_market(
    *,
    event_slug: str = "team-a-vs-team-b",
    fee_type: str = "sports_fees_v2",
    sports_market_type: str = "moneyline",
) -> ScannedMarket:
    return ScannedMarket(
        market_id="sports-market-1",
        question="Will Team A beat Team B?",
        market_url="https://polymarket.com/event/team-a-vs-team-b",
        slug="team-a-to-win",
        close_time=(datetime.now(UTC) + timedelta(days=1)).isoformat(),
        theme="Sports",
        current_yes_odds=95,
        current_no_odds=5,
        volume_usd=10_000,
        liquidity_usd=10_000,
        description=None,
        outcome_labels=["Yes", "No"],
        event_slug=event_slug,
        best_bid_cents=94,
        best_ask_cents=95,
        spread_cents=1,
        volume_24hr_usd=10_000,
        raw={
            "feeType": fee_type,
            "sportsMarketType": sports_market_type,
        },
    )


def _sports_filter_reasons(market: ScannedMarket) -> list[str]:
    return console_market_filter_reasons(
        market,
        now=datetime.now(UTC),
        exclude_sports=False,
        sports_moneyline_only=True,
    )


def test_sports_profile_accepts_supported_moneyline_market() -> None:
    reasons = _sports_filter_reasons(_sports_market())

    assert not any("sports event" in reason.lower() for reason in reasons)
    assert not any("feetype" in reason.lower() for reason in reasons)
    assert not any("sportsmarkettype" in reason.lower() for reason in reasons)


def test_sports_profile_rejects_draw_event_slug() -> None:
    reasons = _sports_filter_reasons(
        _sports_market(event_slug="team-a-vs-team-b-draw")
    )

    assert any('event slug ends with "draw"' in reason for reason in reasons)


def test_sports_profile_rejects_wrong_fee_or_market_type() -> None:
    reasons = _sports_filter_reasons(
        _sports_market(fee_type="crypto_fees", sports_market_type="spread")
    )

    assert any("feeType sports_fees_v2 or sports_fees_v3" in reason for reason in reasons)
    assert any("sportsMarketType is not moneyline" in reason for reason in reasons)
