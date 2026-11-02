"""Descriptive payout lineage; wallet fields never authenticate settlement.

Attestations are trusted internal inputs from a separately verified source adapter,
not deserialized from wallet JSON. No production adapter supplies them yet. This
module checks compatibility, not authenticity or a new finality/freshness policy.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from math import isfinite
from typing import Any, Mapping

PAYOUT_FACT_KEYS = (
    "expected_payout_usdc", "expectedPayoutUSDC", "expectedPayoutUsd",
    "claimableValue", "claimable_value", "redeemableValue", "redeemable_value",
    "currentValue", "current_value", "currentPrice", "current_price", "curPrice",
    "redeemable", "isRedeemable", "upstream_redeemable", "resolution_status", "status",
    "conditionId", "condition_id", "asset", "outcome", "currency", "amount_unit",
    "observed_at", "source", "payout_authority", "source_lots",
)
PAYOUT_AMOUNT_KEYS = PAYOUT_FACT_KEYS[:7]


@dataclass(frozen=True)
class SettlementAttestation:
    """Already-authenticated internal fact, never authority inferred from JSON.

    source_reference identifies retained evidence under source_contract. The
    source verifier, not this module, must establish authority, finality/current
    status and currency/units. No source verifier is enabled by this change.
    """
    amount: float
    condition_id: str
    outcome: str
    currency: str
    unit: str
    source_contract: str
    source_reference: str
    observed_at: datetime
    authority_verified: bool = False
    final: bool | None = None
    current: bool | None = None
    receipt_reference: str | None = None


def raw_payout_facts(row: Mapping[str, Any]) -> dict[str, Any]:
    # Preserve presence and zero; a missing key is not an explicit null or zero.
    return {key: row[key] for key in PAYOUT_FACT_KEYS if key in row}


def _compatible(attestation: SettlementAttestation | None, row: Mapping[str, Any], now: datetime) -> bool:
    if not isinstance(attestation, SettlementAttestation):
        return False
    if not (attestation.authority_verified is True and attestation.final is True and attestation.current is True):
        return False
    if isinstance(attestation.amount, bool) or not isinstance(attestation.amount, (int, float)):
        return False
    if not isfinite(attestation.amount) or attestation.amount < 0:
        return False
    if not all(isinstance(value, str) and value.strip() for value in (attestation.source_contract, attestation.source_reference)):
        return False
    if not isinstance(attestation.observed_at, datetime) or attestation.observed_at.tzinfo is None or attestation.observed_at > now:
        return False
    raw_time = row.get("observed_at")
    if raw_time is None and isinstance(row.get("raw_payout_fields"), Mapping):
        raw_time = row["raw_payout_fields"].get("observed_at")
    try:
        observed = datetime.fromisoformat(raw_time.replace("Z", "+00:00")) if isinstance(raw_time, str) else raw_time
    except ValueError:
        return False
    if not isinstance(observed, datetime) or observed.tzinfo is None or observed > now:
        return False
    # No currency/scale or token-side conversion is guessed.
    return bool(
        attestation.condition_id and attestation.outcome and attestation.currency and attestation.unit
        and attestation.condition_id == (row.get("condition_id") or row.get("conditionId"))
        and attestation.outcome == row.get("outcome")
        and attestation.currency == row.get("currency")
        and attestation.unit == row.get("amount_unit")
    )


def describe_payout_evidence(
    row: Mapping[str, Any], *, valuation: float | None, now: datetime,
    entitlement: SettlementAttestation | None = None,
    realization: SettlementAttestation | None = None,
) -> dict[str, Any]:
    raw = row.get("raw_payout_fields")
    raw = dict(raw) if isinstance(raw, Mapping) else raw_payout_facts(row)
    reported = {key: raw[key] for key in PAYOUT_AMOUNT_KEYS if key in raw}
    transport = raw_payout_facts(row)
    amounts = []
    for value in [*reported.values(), *(row[key] for key in PAYOUT_AMOUNT_KEYS if key in row)]:
        if isinstance(value, bool) or value is None:
            continue
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        if isfinite(numeric):
            amounts.append(numeric)
    conflict = bool(amounts and any(amount != amounts[0] for amount in amounts[1:]))
    entitlement_valid = _compatible(entitlement, row, now) and not conflict and "source_lots" not in raw
    realization_valid = _compatible(realization, row, now) and bool(realization.receipt_reference) and not conflict and "source_lots" not in raw
    # Contradictory reported facts cannot silently be overridden by an attestation.
    if entitlement_valid and amounts and any(amount != entitlement.amount for amount in amounts):
        conflict = True
        entitlement_valid = realization_valid = False
    status = "conflict" if conflict else "confirmed_realization" if realization_valid else "verified_entitlement" if entitlement_valid else "reported_unverified" if reported else "estimated_only" if valuation is not None else "unknown_authority"
    return {
        "schema_version": 1,
        "aggregation_status": "not_verified" if "source_lots" in raw else "single_row",
        "raw_fields": raw,
        "transport_fields": transport,
        "reported_payout": reported,
        "estimated_valuation": valuation,
        "authority_status": status,
        "verified_entitlement": entitlement.amount if entitlement_valid else None,
        "entitlement_reference": entitlement.source_reference if entitlement_valid else None,
        "entitlement_provenance": {"source_contract": entitlement.source_contract,
                                    "observed_at": entitlement.observed_at.isoformat()}
        if entitlement_valid else None,
        "confirmed_realization": realization.amount if realization_valid else None,
        "realization_reference": realization.receipt_reference if realization_valid else None,
        "realization_provenance": {"source_contract": realization.source_contract,
                                    "source_reference": realization.source_reference,
                                    "observed_at": realization.observed_at.isoformat()}
        if realization_valid else None,
        "currency": row.get("currency"),
        "unit": row.get("amount_unit"),
        "authority_limit": "Raw field names, redeemable flags, valuation and elapsed close time do not verify settlement. No production source verifier is enabled.",
    }
