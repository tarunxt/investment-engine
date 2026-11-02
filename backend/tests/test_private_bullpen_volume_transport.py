"""Synthetic private transport regression; trading filters remain unchanged."""
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.domains.polymarket_auto_live.console_profile import console_market_filter_reasons
from app.domains.polymarket_auto_live.engine import _manual_console_market, _serialize_manual_console_candidate
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveConsoleCandidateInput


def candidate(**updates):
    data = dict(question_id="synthetic",market_id="synthetic",market_title="Will the synthetic candidate win?",
                close_time="2026-11-04T00:00:00Z",theme="Politics",current_yes_odds=95,current_no_odds=5,
                volume_usd=1000,volume_24hr_usd=101,liquidity_usd=1000,spread_cents=2)
    data.update(updates)
    return BullpenAutoLiveConsoleCandidateInput.model_validate(data)


@pytest.mark.parametrize("volume", [None,0,100,100.01,250])
def test_supplied_volume_survives_schema_market_and_serialized_candidate(volume):
    row = candidate(volume_24hr_usd=volume)
    market = _manual_console_market(row)
    assert row.model_dump()["volume_24hr_usd"] == volume
    assert market.volume_24hr_usd == volume
    assert _serialize_manual_console_candidate(row,market)["volume_24hr_usd"] == volume


@pytest.mark.parametrize("volume,rejected", [(None,True),(0,True),(100,True),(100.01,False)])
def test_volume_filter_still_requires_strictly_greater_than_existing_threshold(volume,rejected):
    reasons = console_market_filter_reasons(_manual_console_market(candidate(volume_24hr_usd=volume)),
                                           now=datetime(2026,11,1,tzinfo=UTC))
    assert any("volume24hr" in reason for reason in reasons) is rejected


@pytest.mark.parametrize("values,expected", [({"liquidity_usd":100},"Liquidity"),
    ({"volume_usd":100},"Volume USD"),({"spread_cents":10},"spread")])
def test_other_filter_thresholds_are_unchanged(values,expected):
    reasons = console_market_filter_reasons(_manual_console_market(candidate(**values)),now=datetime(2026,11,1,tzinfo=UTC))
    assert any(expected in reason for reason in reasons)


def test_negative_volume_is_rejected_and_missing_never_borrows_total_volume():
    with pytest.raises(ValidationError):
        candidate(volume_24hr_usd=-1)
    row = candidate(volume_24hr_usd=None,volume_usd=99999)
    assert _manual_console_market(row).volume_24hr_usd is None


@pytest.mark.parametrize("row,expected", [({},None),({"expected_payout_usdc":0},0),
    ({"expectedPayoutUSDC":0},0),({"expected_payout_usdc":3},3)])
def test_existing_payout_extractor_keeps_missing_zero_positive_distinct(row,expected):
    from app.domains.polymarket.position_classification import extract_bullpen_expected_payout_usdc
    assert extract_bullpen_expected_payout_usdc(row) == expected


def test_declared_positive_payout_remains_blocked_by_authoritatively_open_market():
    from app.domains.polymarket.position_classification import classify_bullpen_position
    result = classify_bullpen_position({"shares":3,"current_value":3,"expected_payout_usdc":3,"redeemable":True,
        "end_date":"2026-10-01"},authoritative_market_is_open=True,now=datetime(2026,11,1,tzinfo=UTC))
    assert not result.is_claimable
