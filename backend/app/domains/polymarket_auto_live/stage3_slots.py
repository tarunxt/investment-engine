from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from app.domains.polymarket_auto_live.console_profile import ConsoleWalletPosition


@dataclass(frozen=True)
class EconomicSlotAllocation:
    """The economically active, deduplicated view used by Stage 3 sizing."""

    occupied_market_ids: set[str]
    active_positions: list[ConsoleWalletPosition]
    raw_position_count: int
    economically_active_position_count: int
    excluded_position_records: list[dict[str, object]]
    deduplicated_occupied_market_ids: list[str]

    def as_diagnostics(self, *, slot_limit: int) -> dict[str, object]:
        return {
            "slot_limit": slot_limit,
            "raw_position_count": self.raw_position_count,
            "economically_active_position_count": self.economically_active_position_count,
            "excluded_position_records": self.excluded_position_records,
            "deduplicated_occupied_market_ids": self.deduplicated_occupied_market_ids,
            "occupied_market_ids": sorted(self.occupied_market_ids),
        }


def canonical_position_key(position: ConsoleWalletPosition) -> tuple[str, str]:
    """Return the stable condition/market + side identity for one position."""

    identity = (position.condition_id or position.market_id or "").strip().lower()
    return identity, (position.side or "").strip().upper()


def economic_exposure_usd(position: ConsoleWalletPosition) -> float:
    """Prefer current mark-to-market value, falling back to invested value."""

    if position.current_value_usd is not None:
        return max(0.0, float(position.current_value_usd))
    return max(0.0, float(position.exposure_usd or 0.0))


def _position_record(
    position: ConsoleWalletPosition,
    *,
    reason: str,
    canonical_key: tuple[str, str] | None = None,
) -> dict[str, object]:
    return {
        "market_id": position.market_id,
        "condition_id": position.condition_id,
        "side": position.side,
        "shares": position.shares,
        "exposure_usd": position.exposure_usd,
        "current_value_usd": position.current_value_usd,
        "classification": position.classification,
        "classification_reason": position.classification_reason,
        "canonical_key": "::".join(canonical_key) if canonical_key else None,
        "reason": reason,
    }


def classify_economic_slots(
    positions: Iterable[ConsoleWalletPosition],
    *,
    dust_threshold_usd: float,
) -> EconomicSlotAllocation:
    """Exclude non-exposure rows and count each market/side at most once.

    This function intentionally operates on parsed live wallet rows rather
    than persisted Auto-Live positions. Persisted rows can explain a decision,
    but cannot consume a live portfolio slot when the wallet no longer carries
    meaningful exposure.
    """

    rows = list(positions)
    excluded: list[dict[str, object]] = []
    candidates: dict[tuple[str, str], ConsoleWalletPosition] = {}
    candidate_values: dict[tuple[str, str], float] = {}

    excluded_states = {
        "closed": "closed position",
        "resolved_zero_payout": "resolved zero-payout position",
        "positive_payout_claimable": "positive-payout claimable position",
        "settlement_pending": "settlement-only record",
        "settlement_only": "settlement-only record",
        "settlement-only": "settlement-only record",
        "fully_redeemed": "fully redeemed position",
        "redeemed": "fully redeemed position",
        "settled": "fully redeemed position",
        "stale_or_unknown": "stale/non-active position record",
        "closed_position": "closed position",
        "fully_exited": "fully exited position",
        "fully_redeemed_position": "fully redeemed position",
        "positive_payout": "positive-payout claimable position",
        "claimable": "positive-payout claimable position",
        "settlement": "settlement-only record",
    }

    for position in rows:
        key = canonical_position_key(position)
        if not key[0] or not key[1]:
            excluded.append(_position_record(position, reason="missing canonical market or side", canonical_key=key))
            continue

        state_reason = excluded_states.get(str(position.classification or "").lower())
        if state_reason is None and (
            position.is_claimable
            or (position.claimable_value_usd or 0.0) > dust_threshold_usd
            or (position.expected_payout_usdc or 0.0) > dust_threshold_usd
        ):
            state_reason = "positive-payout claimable position"
        if state_reason:
            excluded.append(_position_record(position, reason=state_reason, canonical_key=key))
            continue

        value = economic_exposure_usd(position)
        if value <= max(0.0, dust_threshold_usd):
            excluded.append(
                _position_record(
                    position,
                    reason=f"economic exposure {value:.6f} is at or below dust threshold {dust_threshold_usd:.6f}",
                    canonical_key=key,
                )
            )
            continue

        # A saved-run row may carry a condition ID while the live CLI row only
        # carries a market ID (or vice versa).  Treat either identifier as an
        # alias of the same condition/side instead of consuming two slots.
        matching_key = next(
            (
                candidate_key
                for candidate_key, existing_position in candidates.items()
                if candidate_key[1] == key[1]
                and (
                    (
                        position.condition_id
                        and existing_position.condition_id
                        and position.condition_id.strip().lower()
                        == existing_position.condition_id.strip().lower()
                    )
                    or (
                        position.market_id
                        and existing_position.market_id
                        and position.market_id.strip().lower()
                        == existing_position.market_id.strip().lower()
                    )
                )
            ),
            None,
        )
        existing = candidates.get(matching_key or key)
        if existing is not None:
            existing_key = matching_key or key
            existing_value = candidate_values[existing_key]
            # Keep the strongest live row. The slot is keyed by condition and
            # side, so duplicate API/CLI/saved rows must never add another slot.
            if value > existing_value:
                excluded.append(
                    _position_record(
                        existing,
                        reason="duplicate canonical market/side; replaced by larger live exposure",
                        canonical_key=key,
                    )
                )
                candidates[existing_key] = position
                candidate_values[existing_key] = value
            else:
                excluded.append(
                    _position_record(
                        position,
                        reason="duplicate canonical market/side",
                        canonical_key=key,
                    )
                )
            continue

        candidates[key] = position
        candidate_values[key] = value

    active_positions = list(candidates.values())
    occupied_market_ids = {position.market_id for position in active_positions if position.market_id}
    return EconomicSlotAllocation(
        occupied_market_ids=occupied_market_ids,
        active_positions=active_positions,
        raw_position_count=len(rows),
        economically_active_position_count=len(active_positions),
        excluded_position_records=excluded,
        deduplicated_occupied_market_ids=sorted(occupied_market_ids),
    )
