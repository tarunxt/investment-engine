from app.domains.polymarket_auto_live.router import (
    _effective_filter_profile_settings,
)
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveSettings


def test_sports_profile_defaults_to_shared_full_universe_with_sports_included() -> None:
    settings = BullpenAutoLiveSettings()

    effective = _effective_filter_profile_settings(settings, "bullpen-sports")

    assert effective.console_scan_scope == "full_universe"
    assert effective.console_exclude_sports is False
    assert settings.console_exclude_sports is True


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
