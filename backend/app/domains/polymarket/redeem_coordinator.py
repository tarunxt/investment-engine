from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Awaitable, Callable, Iterable, Sequence

from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.domains.polymarket.logger import redact_secrets
from app.domains.polymarket.models import PolymarketRedeemAttemptRecord
from app.infrastructure.database.sync_session import SyncSessionLocal

logger = get_logger("app.domains.polymarket.redeem_coordinator")

RedeemAttemptStatus = str
ReadWalletPositions = Callable[[], Awaitable[list[object]]]

REDEEM_ATTEMPT_DISCOVERED = "discovered"
REDEEM_ATTEMPT_VERIFIED = "verified"
REDEEM_ATTEMPT_SUBMITTED = "submitted"
REDEEM_ATTEMPT_PENDING = "pending"
REDEEM_ATTEMPT_CONFIRMED = "confirmed"
REDEEM_ATTEMPT_STALE = "stale"
REDEEM_ATTEMPT_ALREADY_REDEEMED = "already_redeemed"
REDEEM_ATTEMPT_RESOLVED_ZERO_PAYOUT = "resolved_zero_payout"

REDEEM_PENDING_STATUSES = {
    REDEEM_ATTEMPT_PENDING,
    REDEEM_ATTEMPT_SUBMITTED,
}
REDEEM_TERMINAL_STATUSES = {
    REDEEM_ATTEMPT_CONFIRMED,
    REDEEM_ATTEMPT_ALREADY_REDEEMED,
    REDEEM_ATTEMPT_RESOLVED_ZERO_PAYOUT,
}
_NO_REDEEMABLE_BALANCE_MARKERS = (
    "no redeemable balance",
    "nothing redeemable",
    "no claimable balance",
)


@dataclass(frozen=True)
class RedeemConditionSnapshot:
    condition_id: str
    market_id: str | None
    market_title: str | None
    shares: float
    classification: str
    claimable_value_usd: float | None
    is_claimable: bool


@dataclass(frozen=True)
class RedeemAttemptOutcome:
    condition_id: str
    status: RedeemAttemptStatus
    market_id: str | None
    market_title: str | None
    detail: str
    execution_response: str | None = None


@dataclass(frozen=True)
class RedeemSubmissionResult:
    outcomes: list[RedeemAttemptOutcome]
    submitted_condition_ids: list[str]
    claim_attempted: bool
    claim_response: str | None
    submission_response: str | None


def _utc_now() -> datetime:
    return datetime.now(UTC)


def normalize_redeem_condition_ids(condition_ids: Iterable[str] | None) -> list[str]:
    if not condition_ids:
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for value in condition_ids:
        item = str(value or "").strip()
        if not item or item in seen:
            continue
        seen.add(item)
        normalized.append(item)
    return normalized


def _position_condition_id(position: object) -> str | None:
    value = getattr(position, "condition_id", None)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _position_aliases(position: object) -> list[str]:
    condition_id = _position_condition_id(position)
    return [condition_id] if condition_id else []


def _position_snapshot(position: object) -> RedeemConditionSnapshot | None:
    classification = getattr(position, "classification", None)
    shares = getattr(position, "shares", 0.0) or 0.0
    if not isinstance(classification, str):
        return None
    alias_list = _position_aliases(position)
    if not alias_list:
        return None
    claimable_value = getattr(position, "expected_payout_usdc", None)
    if claimable_value is None:
        claimable_value = getattr(position, "exposure_usd", None)
    if not isinstance(claimable_value, (int, float)):
        claimable_value = None
    return RedeemConditionSnapshot(
        condition_id=alias_list[0],
        market_id=getattr(position, "market_id", None),
        market_title=getattr(position, "market_title", None),
        shares=float(shares),
        classification=classification,
        claimable_value_usd=float(claimable_value) if claimable_value is not None else None,
        is_claimable=bool(getattr(position, "is_claimable", False)),
    )


def _index_wallet_positions(positions: Sequence[object]) -> dict[str, RedeemConditionSnapshot]:
    indexed: dict[str, RedeemConditionSnapshot] = {}
    for position in positions:
        snapshot = _position_snapshot(position)
        if snapshot is None:
            continue
        for alias in _position_aliases(position):
            indexed[alias] = snapshot
    return indexed


def _submission_balance_missing(message: str) -> bool:
    normalized = message.lower()
    return any(marker in normalized for marker in _NO_REDEEMABLE_BALANCE_MARKERS)


def _attempt_query(
    user_id: int,
    *,
    condition_ids: Sequence[str] | None = None,
    statuses: Sequence[str] | None = None,
) -> Select[tuple[PolymarketRedeemAttemptRecord]]:
    query = select(PolymarketRedeemAttemptRecord).where(
        PolymarketRedeemAttemptRecord.user_id == user_id
    )
    if condition_ids:
        query = query.where(PolymarketRedeemAttemptRecord.condition_id.in_(condition_ids))
    if statuses:
        query = query.where(PolymarketRedeemAttemptRecord.status.in_(statuses))
    return query


class SyncPolymarketRedeemCoordinator:
    def __init__(
        self,
        *,
        session: Session,
        user_id: int,
        executor: object,
        read_wallet_positions: ReadWalletPositions,
    ) -> None:
        self.session = session
        self.user_id = user_id
        self.executor = executor
        self.read_wallet_positions = read_wallet_positions

    def _get_or_create_attempt(
        self,
        *,
        condition_id: str,
        source: str,
    ) -> PolymarketRedeemAttemptRecord:
        record = self.session.execute(
            _attempt_query(self.user_id, condition_ids=[condition_id]).with_for_update()
        ).scalar_one_or_none()
        if record is not None:
            return record
        record = PolymarketRedeemAttemptRecord(
            user_id=self.user_id,
            condition_id=condition_id,
            source=source,
            status=REDEEM_ATTEMPT_DISCOVERED,
            attempt_count=0,
        )
        self.session.add(record)
        self.session.flush()
        return record

    def _apply_snapshot(
        self,
        record: PolymarketRedeemAttemptRecord,
        snapshot: RedeemConditionSnapshot | None,
        *,
        source: str,
    ) -> RedeemAttemptOutcome:
        record.source = source
        record.last_reconciled_at = _utc_now()

        if snapshot is not None:
            record.market_id = snapshot.market_id
            record.market_title = snapshot.market_title
            record.last_seen_shares = snapshot.shares
            record.last_seen_claimable_value_usd = snapshot.claimable_value_usd
        else:
            record.last_seen_shares = None
            record.last_seen_claimable_value_usd = None

        if snapshot is None:
            if record.last_submitted_at is not None:
                record.status = REDEEM_ATTEMPT_CONFIRMED
                record.confirmed_at = record.confirmed_at or _utc_now()
                detail = (
                    "The condition no longer appears in the fresh Bullpen wallet state "
                    "after an earlier redeem submission."
                )
            else:
                record.status = REDEEM_ATTEMPT_ALREADY_REDEEMED
                detail = "No redeemable Bullpen balance remains for this condition."
            record.last_error = None
            return RedeemAttemptOutcome(
                condition_id=record.condition_id,
                status=record.status,
                market_id=record.market_id,
                market_title=record.market_title,
                detail=detail,
                execution_response=record.execution_response,
            )

        if snapshot.classification == "resolved_zero_payout":
            record.status = REDEEM_ATTEMPT_RESOLVED_ZERO_PAYOUT
            record.last_error = None
            return RedeemAttemptOutcome(
                condition_id=record.condition_id,
                status=record.status,
                market_id=record.market_id,
                market_title=record.market_title,
                detail=(
                    "Bullpen still shows the residue in history, but the resolved payout is "
                    "explicitly zero so it must never be redeemed again."
                ),
                execution_response=record.execution_response,
            )

        if snapshot.is_claimable:
            if record.status in REDEEM_PENDING_STATUSES or record.last_submitted_at is not None:
                record.status = REDEEM_ATTEMPT_PENDING
            else:
                record.status = REDEEM_ATTEMPT_VERIFIED
            record.last_error = None
            detail = (
                "Bullpen still shows a positive redeemable payout after an earlier submit."
                if record.status == REDEEM_ATTEMPT_PENDING
                else "Bullpen confirmed a positive redeemable payout for this condition."
            )
            return RedeemAttemptOutcome(
                condition_id=record.condition_id,
                status=record.status,
                market_id=record.market_id,
                market_title=record.market_title,
                detail=detail,
                execution_response=record.execution_response,
            )

        if snapshot.classification in {"settlement_pending", "stale_or_unknown"}:
            record.status = REDEEM_ATTEMPT_STALE
            detail = (
                "Bullpen marked this condition as unsettled or ambiguous, so the coordinator "
                "must reconcile again before any redeem retry."
            )
            return RedeemAttemptOutcome(
                condition_id=record.condition_id,
                status=record.status,
                market_id=record.market_id,
                market_title=record.market_title,
                detail=detail,
                execution_response=record.execution_response,
            )

        record.status = REDEEM_ATTEMPT_DISCOVERED
        record.last_error = None
        return RedeemAttemptOutcome(
            condition_id=record.condition_id,
            status=record.status,
            market_id=record.market_id,
            market_title=record.market_title,
            detail="Bullpen still shows the condition, but it is not a verified redeemable payout yet.",
            execution_response=record.execution_response,
        )

    async def reconcile(
        self,
        *,
        condition_ids: Iterable[str] | None = None,
        source: str,
    ) -> list[RedeemAttemptOutcome]:
        normalized_ids = normalize_redeem_condition_ids(condition_ids)
        if normalized_ids:
            target_ids = normalized_ids
        else:
            target_ids = [
                record.condition_id
                for record in self.session.execute(
                    _attempt_query(
                        self.user_id,
                        statuses=sorted(REDEEM_PENDING_STATUSES | {REDEEM_ATTEMPT_STALE}),
                    )
                ).scalars()
            ]
        if not target_ids:
            return []

        wallet_positions = await self.read_wallet_positions()
        snapshot_index = _index_wallet_positions(wallet_positions)
        outcomes: list[RedeemAttemptOutcome] = []
        for condition_id in target_ids:
            record = self._get_or_create_attempt(condition_id=condition_id, source=source)
            outcomes.append(
                self._apply_snapshot(record, snapshot_index.get(condition_id), source=source)
            )
        self.session.flush()
        return outcomes

    async def submit(
        self,
        *,
        condition_ids: Iterable[str],
        source: str,
        claim_after_submit: bool = False,
    ) -> RedeemSubmissionResult:
        normalized_ids = normalize_redeem_condition_ids(condition_ids)
        if not normalized_ids:
            return RedeemSubmissionResult(
                outcomes=[],
                submitted_condition_ids=[],
                claim_attempted=False,
                claim_response=None,
                submission_response=None,
            )

        outcomes = await self.reconcile(condition_ids=normalized_ids, source=source)
        verified_ids = [
            outcome.condition_id
            for outcome in outcomes
            if outcome.status == REDEEM_ATTEMPT_VERIFIED
        ]
        if not verified_ids:
            return RedeemSubmissionResult(
                outcomes=outcomes,
                submitted_condition_ids=[],
                claim_attempted=False,
                claim_response=None,
                submission_response=None,
            )

        pending_records: list[PolymarketRedeemAttemptRecord] = []
        for condition_id in verified_ids:
            record = self._get_or_create_attempt(condition_id=condition_id, source=source)
            record.status = REDEEM_ATTEMPT_PENDING
            record.source = source
            record.last_error = None
            pending_records.append(record)
        self.session.commit()

        claim_response: str | None = None
        submission_response: str | None = None
        claim_attempted = False
        try:
            submission_response = await self.executor.redeem(
                dry_run=False,
                condition_ids=verified_ids,
            )
            submitted_at = _utc_now()
            for record in pending_records:
                record.status = REDEEM_ATTEMPT_SUBMITTED
                record.attempt_count += 1
                record.last_submitted_at = submitted_at
                record.execution_response = submission_response
                record.last_error = None
            self.session.commit()

            if claim_after_submit:
                claim = getattr(self.executor, "claim", None)
                if callable(claim):
                    claim_attempted = True
                    claim_response = await claim(dry_run=False)
                    if claim_response:
                        for record in pending_records:
                            record.execution_response = (
                                f"{submission_response}\n{claim_response}"
                                if submission_response
                                else claim_response
                            )
                        self.session.commit()

            outcomes = await self.reconcile(condition_ids=verified_ids, source=source)
            return RedeemSubmissionResult(
                outcomes=outcomes,
                submitted_condition_ids=verified_ids,
                claim_attempted=claim_attempted,
                claim_response=claim_response,
                submission_response=submission_response,
            )
        except Exception as exc:
            message = redact_secrets(str(exc))
            if _submission_balance_missing(message):
                outcomes = await self.reconcile(condition_ids=verified_ids, source=source)
                for record in pending_records:
                    if record.status not in REDEEM_TERMINAL_STATUSES:
                        record.status = REDEEM_ATTEMPT_STALE
                        record.last_error = (
                            "Bullpen reported no redeemable balance, but the fresh wallet state "
                            "still needs another reconciliation pass before any retry."
                        )
                self.session.commit()
                return RedeemSubmissionResult(
                    outcomes=await self.reconcile(condition_ids=verified_ids, source=source),
                    submitted_condition_ids=[],
                    claim_attempted=False,
                    claim_response=None,
                    submission_response=None,
                )

            for record in pending_records:
                record.status = REDEEM_ATTEMPT_STALE
                record.last_error = message
            self.session.commit()
            logger.warning(
                "Scoped redeem submission failed user=%s conditions=%s error=%s",
                self.user_id,
                verified_ids,
                message,
            )
            raise


async def reconcile_redeem_attempts(
    *,
    user_id: int,
    condition_ids: Iterable[str] | None,
    source: str,
    executor: object,
    read_wallet_positions: ReadWalletPositions,
) -> list[RedeemAttemptOutcome]:
    with SyncSessionLocal() as session:
        coordinator = SyncPolymarketRedeemCoordinator(
            session=session,
            user_id=user_id,
            executor=executor,
            read_wallet_positions=read_wallet_positions,
        )
        outcomes = await coordinator.reconcile(condition_ids=condition_ids, source=source)
        session.commit()
        return outcomes


async def submit_scoped_redeem(
    *,
    user_id: int,
    condition_ids: Iterable[str],
    source: str,
    executor: object,
    read_wallet_positions: ReadWalletPositions,
    claim_after_submit: bool = False,
) -> RedeemSubmissionResult:
    with SyncSessionLocal() as session:
        coordinator = SyncPolymarketRedeemCoordinator(
            session=session,
            user_id=user_id,
            executor=executor,
            read_wallet_positions=read_wallet_positions,
        )
        return await coordinator.submit(
            condition_ids=condition_ids,
            source=source,
            claim_after_submit=claim_after_submit,
        )
