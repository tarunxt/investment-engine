"""Private candidate: actual adapter/parser/classifier paths with synthetic inputs.

Internal attestation fixtures stipulate prior independent verification; these
fixtures do not establish a live provider verifier or enable a production source.
"""
from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from app.domains.polymarket.payout_provenance import SettlementAttestation
from app.domains.polymarket.position_classification import classify_bullpen_position
from app.domains.polymarket.runtime_positions_refresh import _normalize_public_position, _build_public_summary
from app.domains.polymarket_auto_live.console_profile import read_console_wallet_positions

NOW = datetime(2026,11,1,tzinfo=UTC)


def raw(**changes):
    row = dict(size=3, shares=3, currentValue=3, redeemable=True, outcome="Yes", conditionId="synthetic-condition",
               currency="USDC.e",amount_unit="collateral_units",endDate="2026-10-01",observed_at="2026-10-31T23:59:00Z")
    row.update(changes)
    return row


def attestation(amount=3, **changes):
    values = dict(amount=amount, condition_id="synthetic-condition",outcome="Yes",currency="USDC.e",
                  unit="collateral_units",source_contract="synthetic-preverified-fixture",source_reference="fixture:resolution:1",
                  observed_at=NOW-timedelta(minutes=1),authority_verified=True,final=True,current=True)
    values.update(changes)
    return SettlementAttestation(**values)


@pytest.mark.parametrize("reported", [None,0,3,7])
def test_adapter_keeps_reported_amount_separate_from_valuation_and_does_not_invent_status(reported):
    source = raw(expected_payout_usdc=reported)
    before = deepcopy(source)
    normalized = _normalize_public_position(source)
    assert source == before
    assert normalized["expected_payout_usdc"] == reported
    assert normalized["current_value"] == 3
    assert normalized["resolution_status"] is None
    assert normalized["raw_payout_fields"]["expected_payout_usdc"] == reported
    result = classify_bullpen_position(normalized,now=NOW)
    assert not result.is_claimable
    assert result.payout_evidence["verified_entitlement"] is None
    assert result.payout_evidence["confirmed_realization"] is None


def test_missing_adapter_payout_stays_missing_and_summary_is_qualified():
    normalized = _normalize_public_position(raw())
    assert normalized["expected_payout_usdc"] is None
    assert "expected_payout_usdc" not in normalized["raw_payout_fields"]
    summary = _build_public_summary([normalized],cash_balance=0)
    assert summary["claimable_value"] == 3
    assert "estimate_not_verified" in summary["claimable_value_basis"]
    assert summary["verified_entitlement"] is None and summary["confirmed_realization"] is None


@pytest.mark.parametrize("extra", [{},{"status":"settled"},{"status":"unresolved"},{"expected_payout_usdc":0},
    {"expected_payout_usdc":3},{"claimableValue":3},{"payout_authority":"verified","status":"settled"}])
def test_no_raw_wallet_field_or_elapsed_time_supplies_authority(extra):
    source = raw(**extra)
    result = classify_bullpen_position(source,now=NOW)
    assert not result.is_claimable
    assert result.state != "positive_payout_claimable"
    assert result.payout_evidence["verified_entitlement"] is None
    assert result.payout_evidence["estimated_valuation"] == 3


def test_conflicting_reports_preserve_zero_and_reject_even_attested_override():
    source = raw(expected_payout_usdc=0,claimableValue=3)
    result = classify_bullpen_position(source,now=NOW,settlement_entitlement=attestation())
    assert not result.is_claimable
    assert result.payout_evidence["authority_status"] == "conflict"
    assert result.payout_evidence["reported_payout"] == {"expected_payout_usdc":0,"claimableValue":3}


@pytest.mark.parametrize("amount",[0,3,.5])
def test_stipulated_verified_entitlement_keeps_zero_positive_and_split_distinct_from_cash(amount):
    source = raw(expected_payout_usdc=amount)
    result = classify_bullpen_position(source,now=NOW,settlement_entitlement=attestation(amount))
    assert result.payout_evidence["verified_entitlement"] == amount
    assert result.payout_evidence["confirmed_realization"] is None
    assert result.is_claimable is (amount > 0)
    assert result.state == ("positive_payout_claimable" if amount > 0 else "resolved_zero_payout")


@pytest.mark.parametrize("changes", [{"authority_verified":False},{"final":False},{"final":None},{"current":False},
    {"current":None},{"unit":"cents"},{"currency":"pUSD"},{"condition_id":"other"},{"outcome":"No"},
    {"source_reference":""},{"observed_at":NOW+timedelta(seconds=1)},
    {"observed_at":NOW.replace(tzinfo=None)},{"amount":float("nan")}])
def test_unsettled_stale_missing_or_incompatible_provenance_never_verifies(changes):
    result = classify_bullpen_position(raw(),now=NOW,settlement_entitlement=attestation(**changes))
    assert not result.is_claimable
    assert result.payout_evidence["verified_entitlement"] is None


def test_receipt_is_separate_and_does_not_substitute_for_entitlement():
    receipt = attestation(amount=2, receipt_reference="fixture:confirmed-receipt:2")
    result = classify_bullpen_position(raw(),now=NOW,confirmed_realization=receipt)
    assert not result.is_claimable
    assert result.payout_evidence["verified_entitlement"] is None
    assert result.payout_evidence["confirmed_realization"] == 2
    assert result.payout_evidence["realization_reference"] == "fixture:confirmed-receipt:2"
    no_receipt = classify_bullpen_position(raw(),now=NOW,confirmed_realization=replace(receipt,receipt_reference=None))
    assert no_receipt.payout_evidence["confirmed_realization"] is None


def test_authoritative_open_market_override_remains_fail_closed():
    result = classify_bullpen_position(raw(),now=NOW,authoritative_market_is_open=True,settlement_entitlement=attestation())
    assert not result.is_claimable
    assert result.payout_evidence["authority_status"] == "conflict"


@pytest.mark.anyio
@pytest.mark.parametrize("reported", [None,0,3])
async def test_normalization_console_classifier_end_to_end_preserves_unknown_authority(reported):
    source = raw(expected_payout_usdc=reported,slug="synthetic-payout",title="Synthetic payout")
    original = deepcopy(source)
    normalized = _normalize_public_position(source)
    positions = await read_console_wallet_positions(snapshot_payload={"positions":[normalized]})
    assert source == original and len(positions) == 1
    position = positions[0]
    assert not position.is_claimable and position.expected_payout_usdc == reported
    assert position.payout_evidence["raw_fields"]["expected_payout_usdc"] == reported
    assert position.payout_evidence["raw_fields"]["observed_at"] == source["observed_at"]
    assert position.payout_evidence["verified_entitlement"] is None


def test_raw_envelope_cannot_hide_conflicting_transport_or_create_authority():
    row = raw(expected_payout_usdc=0,raw_payout_fields={"expected_payout_usdc":3})
    result = classify_bullpen_position(row,now=NOW,settlement_entitlement=attestation())
    assert not result.is_claimable
    assert result.payout_evidence["authority_status"] == "conflict"
    assert result.payout_evidence["transport_fields"]["expected_payout_usdc"] == 0


def test_raw_dict_cannot_deserialize_itself_into_a_verified_attestation():
    fake = dict(amount=3,authority_verified=True,final=True,current=True)
    result = classify_bullpen_position(raw(),now=NOW,settlement_entitlement=fake)
    assert not result.is_claimable and result.payout_evidence["verified_entitlement"] is None


@pytest.mark.parametrize("changes",[{"currency":None},{"amount_unit":None},{"observed_at":None},
    {"observed_at":"invalid"},{"observed_at":"2026-11-02T00:00:00Z"}])
def test_missing_or_future_source_units_currency_time_cannot_verify(changes):
    result = classify_bullpen_position(raw(**changes),now=NOW,settlement_entitlement=attestation())
    assert not result.is_claimable and result.payout_evidence["verified_entitlement"] is None


@pytest.mark.anyio
async def test_lot_merge_keeps_original_zero_and_positive_source_rows():
    sources = [raw(expected_payout_usdc=0,slug="same",title="Synthetic"),
               raw(expected_payout_usdc=3,slug="same",title="Synthetic")]
    before = deepcopy(sources)
    positions = await read_console_wallet_positions(snapshot_payload={"positions":[_normalize_public_position(r) for r in sources]})
    assert sources == before and len(positions) == 1
    lots = positions[0].payout_evidence["raw_fields"]["source_lots"]
    assert [lot["raw_payout_fields"]["expected_payout_usdc"] for lot in lots] == [0,3]
    assert positions[0].payout_evidence["aggregation_status"] == "not_verified"
    assert not positions[0].is_claimable


@pytest.mark.anyio
async def test_unverified_valuation_cannot_reenter_claim_eligibility_through_coordinator_metadata():
    from app.domains.polymarket.redeem_coordinator import _position_snapshot
    from app.domains.polymarket_auto_live.engine import _serialize_active_wallet_position

    source = raw(slug="synthetic-no-bypass",title="Synthetic",expected_payout_usdc=0,avgPrice=.5)
    positions = await read_console_wallet_positions(snapshot_payload={"positions":[_normalize_public_position(source)]})
    position = positions[0]
    serialized = _serialize_active_wallet_position(position)
    assert serialized["payout_evidence"]["raw_fields"]["expected_payout_usdc"] == 0
    snapshot = _position_snapshot(position)
    assert snapshot is not None and not snapshot.is_claimable
    assert snapshot.classification != "positive_payout_claimable"
    assert position.expected_payout_usdc == 0 and snapshot.claimable_value_usd == 0


@pytest.mark.parametrize("amount",[0,2])
def test_actual_realization_fixture_retains_amount_and_currency_without_enabling_claims(amount):
    receipt = attestation(amount=amount,receipt_reference="fixture:confirmed-only")
    result = classify_bullpen_position(raw(),now=NOW,confirmed_realization=receipt)
    assert result.payout_evidence["confirmed_realization"] == amount
    assert result.payout_evidence["currency"] == "USDC.e"
    assert result.payout_evidence["authority_status"] == "confirmed_realization"
    assert not result.is_claimable
