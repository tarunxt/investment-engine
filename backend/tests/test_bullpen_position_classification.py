import os
from datetime import UTC, datetime

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://test:test@localhost:5432/testdb",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

from app.domains.polymarket.logger import redact_secrets
from app.domains.polymarket.position_classification import (
    BULLPEN_POSITION_CLASSIFIER_VERSION,
    classify_bullpen_position,
)


def test_resolved_zero_payout_residue_is_not_claimable():
    classification = classify_bullpen_position(
        {
            "market": "Will Claude Fable 5 be restored for US customers by July 3?",
            "outcome": "No",
            "shares": 6.0975,
            "current_price": 0,
            "current_value": 0,
            "expected_payout_usdc": 0,
            "redeemable": True,
            "resolution_status": "unknown",
            "end_date": "2026-07-03",
        }
    )

    assert classification.state == "resolved_zero_payout"
    assert classification.is_claimable is False
    assert classification.claimable_value_usd is None


def test_positive_claimable_value_stays_claimable():
    classification = classify_bullpen_position(
        {
            "market": "Resolved winner",
            "outcome": "No",
            "shares": 3,
            "current_price": 1,
            "current_value": 3,
            "redeemable": True,
            "claimableValue": 3,
            "end_date": "2026-07-03",
        }
    )

    assert classification.state == "positive_payout_claimable"
    assert classification.is_claimable is True
    assert classification.claimable_value_usd == 3


def test_authoritative_open_market_overrides_stale_redeemable_evidence():
    classification = classify_bullpen_position(
        {
            "market": "Still-open NO position",
            "outcome": "No",
            "shares": 8.769,
            "current_price": 0.74,
            "current_value": 6.49,
            "redeemable": True,
            "claimableValue": 6.49,
            "resolution_status": "open",
            "end_date": "2026-07-22",
        },
        authoritative_market_is_open=True,
        now=datetime(2026, 7, 21, 0, 0, tzinfo=UTC),
    )

    assert classification.state == "active"
    assert classification.is_claimable is False
    assert classification.claimable_value_usd is None


def test_authoritative_closed_market_can_never_remain_active():
    classification = classify_bullpen_position(
        {
            "market": "Explicitly closed market",
            "outcome": "No",
            "shares": 8,
            "current_price": 0.74,
            "current_value": 5.92,
            "resolution_status": "open",
            "end_date": "2026-08-22",
        },
        authoritative_market_is_open=False,
        now=datetime(2026, 7, 21, 0, 0, tzinfo=UTC),
    )

    assert BULLPEN_POSITION_CLASSIFIER_VERSION == 4
    assert classification.state == "stale_or_unknown"
    assert classification.is_claimable is False
    assert "not open" in classification.reason


def test_unresolved_missing_price_stays_stale_unknown():
    classification = classify_bullpen_position(
        {
            "market": "Open position with missing price",
            "outcome": "No",
            "shares": 4,
            "resolution_status": "open",
            "end_date": "2026-08-01",
        },
        now=datetime(2026, 7, 19, 12, 0, tzinfo=UTC),
    )

    assert classification.state == "stale_or_unknown"
    assert classification.is_claimable is False


def test_upstream_redeemable_zero_value_v0115_row_stays_non_active():
    classification = classify_bullpen_position(
        {
            "market": "Will Claude Fable 5 be restored for US customers by July 3, 2026?",
            "outcome": "No",
            "shares": 6.0975,
            "current_price": 0,
            "current_value": 0,
            "expected_payout_usdc": 0,
            "redeemable": False,
            "upstream_redeemable": True,
            "resolution_status": "unknown",
            "end_date": "2026-07-03",
        },
        now=datetime(2026, 7, 19, 12, 0, tzinfo=UTC),
    )

    assert classification.state == "resolved_zero_payout"
    assert classification.is_claimable is False
    assert classification.claimable_value_usd is None


def test_future_open_position_with_temporary_pricing_gap_is_quarantined():
    classification = classify_bullpen_position(
        {
            "market": "Will Trump meet with Netanyahu by July 24, 2026?",
            "outcome": "No",
            "shares": 4,
            "current_price": None,
            "current_value": None,
            "expected_payout_usdc": 0,
            "redeemable": False,
            "upstream_redeemable": False,
            "resolution_status": "open",
            "end_date": "2026-07-24",
        },
        now=datetime(2026, 7, 19, 12, 0, tzinfo=UTC),
    )

    assert classification.state == "stale_or_unknown"
    assert classification.is_claimable is False


def test_redaction_preserves_public_condition_ids_and_tx_hashes():
    condition_id = (
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
    )
    tx_hash = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
    redacted = redact_secrets(
        f"condition={condition_id} tx={tx_hash} private_key=secret-value"
    )

    assert condition_id in redacted
    assert tx_hash in redacted
    assert "private_key=[REDACTED]" in redacted
