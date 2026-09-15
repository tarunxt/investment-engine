from __future__ import annotations

from typing import Literal

from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveSettings

BullpenWorkspaceProfile = Literal["bullpen007", "bullpen-sports"]
WORKFLOW_TRIGGER_PROFILES: tuple[BullpenWorkspaceProfile, ...] = (
    "bullpen007",
    "bullpen-sports",
)

NAMED_FILTER_PROFILES = {"bullpen-sports"}
FILTER_PROFILE_FIELDS = {
    "console_min_market_odds",
    "console_min_highest_market_odds",
    "console_apply_yes_no_odds_thresholds",
    "console_max_closing_days",
    "console_min_volume_usd",
    "console_min_liquidity_usd",
    "console_min_volume_24hr_usd",
    "console_max_spread_cents",
    "console_rejected_theme_pattern",
    "console_exclude_sports",
    "console_sports_moneyline_only",
    "console_exclude_weather",
    "console_exclude_market_predictions",
    "console_exclude_tweet_count_questions",
    "console_exclude_released_by_events",
    "console_only_binary_yes_no",
    "console_exclude_custom_phrases",
    "console_custom_exclude_phrases",
    "console_scan_scope",
}


def effective_filter_profile_settings(
    settings: BullpenAutoLiveSettings,
    profile: BullpenWorkspaceProfile,
) -> BullpenAutoLiveSettings:
    default_overlay: dict[str, object] = {}
    if profile == "bullpen-sports":
        default_overlay = {
            "console_exclude_sports": False,
            "console_sports_moneyline_only": True,
            "console_scan_scope": "full_universe",
        }
    saved_overlay = settings.console_filter_profiles.get(profile, {})
    overlay = {
        key: value
        for key, value in {**default_overlay, **saved_overlay}.items()
        if key in FILTER_PROFILE_FIELDS
    }
    return settings.model_copy(update=overlay)
