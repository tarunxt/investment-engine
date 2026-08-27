from app.domains.polymarket_auto_live.returns_formula import (
    DEFAULT_RETURNS_PER_DAY_FORMULA,
    ReturnsPerDayFormulaError,
    calculate_returns_per_day_formula,
    validate_returns_per_day_formula,
)
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveSettings
from pydantic import ValidationError


def test_default_returns_formula_adds_four_days() -> None:
    assert calculate_returns_per_day_formula(
        current_chosen_side_bullpen_odds=80,
        days_until_close=6,
    ) == 2.0


def test_excel_style_formula_is_normalized_and_evaluated() -> None:
    formula = "=(100-current_chosen_side_bullpen_odds)/(days_until_close+2)"
    assert validate_returns_per_day_formula(formula) == (
        "=(100-CURRENT_CHOSEN_SIDE_BULLPEN_ODDS)/(DAYS_UNTIL_CLOSE+2)"
    )
    assert calculate_returns_per_day_formula(
        current_chosen_side_bullpen_odds=70,
        days_until_close=3,
        formula=formula,
    ) == 6.0


def test_invalid_formula_is_rejected() -> None:
    try:
        validate_returns_per_day_formula("=SUM(1, 2)")
    except ReturnsPerDayFormulaError as exc:
        assert "supported" in str(exc).lower()
    else:
        raise AssertionError("unsafe Excel function should be rejected")


def test_default_formula_constant_matches_saved_setting_default() -> None:
    assert DEFAULT_RETURNS_PER_DAY_FORMULA.endswith("/(DAYS_UNTIL_CLOSE+4)")


def test_settings_remember_a_normalized_custom_formula() -> None:
    settings = BullpenAutoLiveSettings(
        returns_per_day_formula=(
            "=(100-current_chosen_side_bullpen_odds)/(days_until_close+7)"
        )
    )
    assert settings.returns_per_day_formula.endswith("/(DAYS_UNTIL_CLOSE+7)")


def test_settings_reject_an_unsupported_excel_formula() -> None:
    try:
        BullpenAutoLiveSettings(returns_per_day_formula="=SUM(1,2)")
    except ValidationError as exc:
        assert "supported" in str(exc).lower()
    else:
        raise AssertionError("invalid formula should fail persisted-settings validation")
