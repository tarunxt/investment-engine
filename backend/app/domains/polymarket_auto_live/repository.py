from __future__ import annotations

from datetime import UTC, datetime
from typing import Iterable, Sequence

from pydantic import ValidationError
from sqlalchemy import Select, desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveDecisionRecord,
    PolymarketAutoLivePositionRecord,
    PolymarketAutoLiveRunRecord,
    PolymarketAutoLiveSettingsRecord,
    PolymarketAutoLiveStateRecord,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveRun,
    BullpenAutoLiveSettings,
    BullpenAutoLiveState,
)

logger = get_logger("app.domains.polymarket_auto_live.repository")

VALID_AUTO_LIVE_STATUSES = {
    "running",
    "paused",
    "stopped",
    "error",
    "not-configured",
}
ACTIVE_AUTO_LIVE_RUN_STATUSES = ("running", "confirming")

LEGACY_AUTO_LIVE_STATUS_MAP = {
    "idle": "stopped",
    "not_configured": "not-configured",
    "not configured": "not-configured",
    "": "not-configured",
}


def utc_now() -> datetime:
    return datetime.now(UTC)


def _isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat()


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _payload_or_default(payload: dict[str, object] | None) -> dict[str, object]:
    return payload.copy() if payload else {}


def normalize_auto_live_status(value: object) -> str:
    raw = str(value or "").strip().lower()
    status = LEGACY_AUTO_LIVE_STATUS_MAP.get(raw, raw)
    if status not in VALID_AUTO_LIVE_STATUSES:
        return "error"
    return status


def settings_to_record_payload(settings: BullpenAutoLiveSettings) -> dict[str, object]:
    return settings.model_dump(mode="json")


def state_to_record_payload(state: BullpenAutoLiveState) -> dict[str, object]:
    return state.model_dump(mode="json")


def run_to_record_payload(run: BullpenAutoLiveRun) -> dict[str, object]:
    return run.model_dump(mode="json")


def decision_to_record_payload(decision: BullpenAutoLiveDecision) -> dict[str, object]:
    return decision.model_dump(mode="json")


def record_to_settings(record: PolymarketAutoLiveSettingsRecord | None) -> BullpenAutoLiveSettings:
    if record is None:
        return BullpenAutoLiveSettings()
    return BullpenAutoLiveSettings.model_validate(record.payload or {})


def record_to_state(record: PolymarketAutoLiveStateRecord | None) -> BullpenAutoLiveState:
    if record is None:
        return BullpenAutoLiveState()
    payload = _payload_or_default(record.payload)
    payload.update(
        {
            "running": record.running,
            "paused": record.paused,
            "status": record.status,
            "mode": record.mode,
            "last_run_at": _isoformat(record.last_run_at),
            "next_run_at": _isoformat(record.next_run_at),
        }
    )
    payload["status"] = normalize_auto_live_status(payload.get("status"))
    return BullpenAutoLiveState.model_validate(payload)


def record_to_run(record: PolymarketAutoLiveRunRecord) -> BullpenAutoLiveRun:
    payload = _payload_or_default(record.payload)
    payload.update(
        {
            "id": record.id,
            "status": record.status,
            "triggered_by": record.triggered_by,
            "dry_run": record.dry_run,
            "started_at": _isoformat(record.started_at),
            "completed_at": _isoformat(record.completed_at),
            "live_execution_requested": record.live_execution_requested,
            "live_execution_attempted": record.live_execution_attempted,
            "decisions_count": record.decisions_count,
            "orders_planned": record.orders_planned,
            "orders_submitted": record.orders_submitted,
            "summary": record.summary,
            "error_message": record.error_message,
        }
    )
    return BullpenAutoLiveRun.model_validate(payload)


def _record_id(record: PolymarketAutoLiveDecisionRecord) -> str:
    return f"{record.id} (run={record.run_id}, market={record.market_id})"


def record_to_decision(record: PolymarketAutoLiveDecisionRecord) -> BullpenAutoLiveDecision:
    payload = _payload_or_default(record.payload)
    payload.update(
        {
            "id": record.id,
            "run_id": record.run_id,
            "market_id": record.market_id,
            "slug": record.slug,
            "market_title": record.market_title,
            "side": record.side,
            "decision": record.decision,
            "risk_status": record.risk_status,
            "edge_pp": record.edge_pp,
            "score": record.score,
            "created_at": _isoformat(record.created_at),
            "updated_at": _isoformat(record.updated_at),
        }
    )
    try:
        return BullpenAutoLiveDecision.model_validate(payload)
    except ValidationError as exc:
        if payload.get("order_plan") is not None:
            fallback_payload = payload.copy()
            fallback_payload["order_plan"] = None
            try:
                decision = BullpenAutoLiveDecision.model_validate(fallback_payload)
            except ValidationError:
                pass
            else:
                logger.warning(
                    "Dropped malformed Auto-Live order_plan while hydrating decision %s: %s",
                    _record_id(record),
                    exc,
                )
                return decision
        raise


def extract_stage3_decisions_from_run(
    run: BullpenAutoLiveRun,
) -> list[BullpenAutoLiveDecision] | None:
    invest_stages = [
        stage
        for stage in run.stage_results
        if (
            isinstance(stage.outputs, dict)
            and stage.outputs.get("workflow_stage_key") == "invest"
        )
        or stage.stage_number == 3
    ]
    if not invest_stages:
        return None

    invest_stage = max(invest_stages, key=lambda stage: stage.stage_number)
    raw_rows = invest_stage.outputs.get("decision_rows")
    if not isinstance(raw_rows, list):
        return []

    decisions: list[BullpenAutoLiveDecision] = []
    fallback_updated_at = invest_stage.completed_at or invest_stage.started_at or run.completed_at
    fallback_created_at = invest_stage.started_at or run.started_at
    for index, raw_row in enumerate(raw_rows, start=1):
        if not isinstance(raw_row, dict):
            continue

        payload = dict(raw_row)
        payload.setdefault("run_id", run.id)
        payload.setdefault("created_at", fallback_created_at)
        payload.setdefault("updated_at", fallback_updated_at or fallback_created_at)
        try:
            decisions.append(BullpenAutoLiveDecision.model_validate(payload))
        except ValidationError as exc:
            logger.warning(
                "Skipping malformed Stage 3 decision row %s for run %s during recovery: %s",
                index,
                run.id,
                exc,
            )
    return decisions


def apply_settings_to_record(
    record: PolymarketAutoLiveSettingsRecord,
    settings: BullpenAutoLiveSettings,
) -> None:
    record.payload = settings_to_record_payload(settings)


def apply_state_to_record(
    record: PolymarketAutoLiveStateRecord,
    state: BullpenAutoLiveState,
) -> None:
    normalized_status = normalize_auto_live_status(state.status)
    record.running = state.running
    record.paused = state.paused
    record.status = normalized_status
    record.mode = state.mode
    record.last_run_at = _parse_datetime(state.last_run_at)
    record.next_run_at = _parse_datetime(state.next_run_at)
    payload = state_to_record_payload(state)
    payload["status"] = normalized_status
    record.payload = payload


def apply_run_to_record(
    record: PolymarketAutoLiveRunRecord,
    run: BullpenAutoLiveRun,
    *,
    user_id: int,
) -> None:
    record.id = run.id
    record.user_id = user_id
    record.status = run.status
    record.triggered_by = run.triggered_by
    record.dry_run = run.dry_run
    record.started_at = _parse_datetime(run.started_at) or utc_now()
    record.completed_at = _parse_datetime(run.completed_at)
    record.live_execution_requested = run.live_execution_requested
    record.live_execution_attempted = run.live_execution_attempted
    record.decisions_count = run.decisions_count
    record.orders_planned = run.orders_planned
    record.orders_submitted = run.orders_submitted
    record.summary = run.summary
    record.error_message = run.error_message
    payload = run_to_record_payload(run)
    # A worker heartbeat is persisted from a short independent session while
    # the long-running planner retains its own SQLAlchemy session.  Preserve a
    # newer heartbeat when a normal workflow progress save writes the complete
    # run payload from that older session.
    from app.domains.polymarket_auto_live.run_lifecycle import (
        merge_task_lifecycle_payload,
    )

    existing_payload = record.payload if isinstance(record.payload, dict) else {}
    payload["task_lifecycle"] = merge_task_lifecycle_payload(
        existing_payload.get("task_lifecycle"),
        payload.get("task_lifecycle"),
    )
    record.payload = payload


def apply_decision_to_record(
    record: PolymarketAutoLiveDecisionRecord,
    decision: BullpenAutoLiveDecision,
    *,
    user_id: int,
) -> None:
    record.id = decision.id
    record.user_id = user_id
    record.run_id = decision.run_id
    record.market_id = decision.market_id
    record.slug = decision.slug
    record.market_title = decision.market_title
    record.side = decision.side
    record.decision = decision.decision
    record.risk_status = decision.risk_status
    record.edge_pp = decision.edge_pp
    record.score = decision.score
    record.payload = decision_to_record_payload(decision)


def active_position_query(user_id: int) -> Select[tuple[PolymarketAutoLivePositionRecord]]:
    return (
        select(PolymarketAutoLivePositionRecord)
        .where(PolymarketAutoLivePositionRecord.user_id == user_id)
        .where(PolymarketAutoLivePositionRecord.closed_at.is_(None))
        .order_by(
            desc(PolymarketAutoLivePositionRecord.updated_at),
            desc(PolymarketAutoLivePositionRecord.id),
        )
    )


class AsyncPolymarketAutoLiveRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_settings_record(
        self, user_id: int
    ) -> PolymarketAutoLiveSettingsRecord | None:
        return await self.session.get(PolymarketAutoLiveSettingsRecord, user_id)

    async def get_state_record(self, user_id: int) -> PolymarketAutoLiveStateRecord | None:
        return await self.session.get(PolymarketAutoLiveStateRecord, user_id)

    async def ensure_settings(self, user_id: int) -> BullpenAutoLiveSettings:
        record = await self.get_settings_record(user_id)
        if record is None:
            record = PolymarketAutoLiveSettingsRecord(user_id=user_id, payload={})
            self.session.add(record)
            await self.session.flush()
        return record_to_settings(record)

    async def ensure_state(self, user_id: int) -> BullpenAutoLiveState:
        record = await self.get_state_record(user_id)
        if record is None:
            record = PolymarketAutoLiveStateRecord(
                user_id=user_id,
                running=False,
                paused=False,
                status="not-configured",
                mode="dry-run",
                payload={},
            )
            self.session.add(record)
            await self.session.flush()
        return record_to_state(record)

    async def lock_state_record(self, user_id: int) -> BullpenAutoLiveState:
        """Serialize scheduler mutations and run creation for one user."""

        record = (
            await self.session.execute(
                select(PolymarketAutoLiveStateRecord)
                .where(PolymarketAutoLiveStateRecord.user_id == user_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        ).scalar_one()
        return record_to_state(record)

    async def save_settings(self, user_id: int, settings: BullpenAutoLiveSettings) -> None:
        record = await self.get_settings_record(user_id)
        if record is None:
            record = PolymarketAutoLiveSettingsRecord(user_id=user_id, payload={})
            self.session.add(record)
        apply_settings_to_record(record, settings)
        await self.session.flush()

    async def save_state(self, user_id: int, state: BullpenAutoLiveState) -> None:
        record = await self.get_state_record(user_id)
        if record is None:
            record = PolymarketAutoLiveStateRecord(
                user_id=user_id,
                running=False,
                paused=False,
                status=state.status,
                mode=state.mode,
                payload={},
            )
            self.session.add(record)
        apply_state_to_record(record, state)
        await self.session.flush()

    async def get_running_run_record(
        self,
        user_id: int,
        *,
        for_update: bool = False,
    ) -> PolymarketAutoLiveRunRecord | None:
        query = (
            select(PolymarketAutoLiveRunRecord)
            .where(PolymarketAutoLiveRunRecord.user_id == user_id)
            .where(PolymarketAutoLiveRunRecord.status == "running")
            .order_by(
                desc(PolymarketAutoLiveRunRecord.started_at),
                desc(PolymarketAutoLiveRunRecord.created_at),
            )
            .limit(1)
        )
        if for_update:
            # A stop request and a worker progress write can arrive at nearly
            # the same time.  Refresh while holding the row lock so the stop
            # always applies to the latest persisted run rather than a stale
            # identity-map copy.
            query = query.with_for_update().execution_options(populate_existing=True)
        return (await self.session.execute(query)).scalar_one_or_none()

    async def get_active_run_identity(
        self,
        user_id: int,
    ) -> tuple[str, str] | None:
        """Return only the current durable run identity for first-paint polling.

        This is deliberately a narrow indexed read rather than a full run
        deserialization or worker inspection. ``running`` and ``confirming``
        are the only non-terminal Auto-Live run statuses.
        """

        row = (
            await self.session.execute(
                select(
                    PolymarketAutoLiveRunRecord.id,
                    PolymarketAutoLiveRunRecord.status,
                )
                .where(PolymarketAutoLiveRunRecord.user_id == user_id)
                .where(
                    PolymarketAutoLiveRunRecord.status.in_(
                        ACTIVE_AUTO_LIVE_RUN_STATUSES
                    )
                )
                .order_by(
                    desc(PolymarketAutoLiveRunRecord.started_at),
                    desc(PolymarketAutoLiveRunRecord.created_at),
                )
                .limit(1)
            )
        ).one_or_none()
        if row is None:
            return None
        return str(row.id), str(row.status)

    async def get_run_for_user(
        self,
        user_id: int,
        run_id: str,
    ) -> BullpenAutoLiveRun | None:
        """Load one durable run without allowing cross-user ID discovery."""

        record = (
            await self.session.execute(
                select(PolymarketAutoLiveRunRecord)
                .where(PolymarketAutoLiveRunRecord.id == run_id)
                .where(PolymarketAutoLiveRunRecord.user_id == user_id)
                .limit(1)
            )
        ).scalar_one_or_none()
        return record_to_run(record) if record is not None else None

    async def save_run(self, user_id: int, run: BullpenAutoLiveRun) -> None:
        # A planning worker keeps a session open while its independent
        # heartbeat transaction updates the same JSON payload.  Refresh and
        # lock just before a full-payload write so this save cannot overwrite
        # a heartbeat that committed after the worker originally loaded the
        # record.  The lock is held only for the short persistence section.
        execute = getattr(self.session, "execute", None)
        if callable(execute):
            record = (
                await execute(
                    select(PolymarketAutoLiveRunRecord)
                    .where(PolymarketAutoLiveRunRecord.id == run.id)
                    .with_for_update()
                    # Do not let ORM autoflush write a stale identity-map payload
                    # before this locking refresh has observed the heartbeat.
                    .execution_options(populate_existing=True, autoflush=False)
                )
            ).scalar_one_or_none()
        else:
            # Lightweight repository doubles used by API unit tests expose the
            # original ``get``/``add`` protocol only. Real AsyncSession always
            # takes the locked path above.
            record = await self.session.get(PolymarketAutoLiveRunRecord, run.id)
        if record is None:
            record = PolymarketAutoLiveRunRecord(
                id=run.id,
                user_id=user_id,
                status=run.status,
                triggered_by=run.triggered_by,
                dry_run=run.dry_run,
                started_at=_parse_datetime(run.started_at) or utc_now(),
                summary=run.summary,
                payload={},
            )
            self.session.add(record)
        apply_run_to_record(record, run, user_id=user_id)
        await self.session.flush()

    async def count_decisions_by_run(self, run_ids: Sequence[str]) -> dict[str, int]:
        if not run_ids:
            return {}
        rows = (
            await self.session.execute(
                select(
                    PolymarketAutoLiveDecisionRecord.run_id,
                    func.count(PolymarketAutoLiveDecisionRecord.id),
                )
                .where(PolymarketAutoLiveDecisionRecord.run_id.in_(tuple(run_ids)))
                .group_by(PolymarketAutoLiveDecisionRecord.run_id)
            )
        ).all()
        return {str(run_id): int(count) for run_id, count in rows}

    async def replace_run_decisions_from_stage3_payload(
        self,
        user_id: int,
        run: BullpenAutoLiveRun,
    ) -> int:
        decisions = extract_stage3_decisions_from_run(run)
        if decisions is None:
            return 0

        existing = (
            await self.session.execute(
                select(PolymarketAutoLiveDecisionRecord).where(
                    PolymarketAutoLiveDecisionRecord.run_id == run.id
                )
            )
        ).scalars().all()
        for row in existing:
            await self.session.delete(row)

        for decision in decisions:
            record = PolymarketAutoLiveDecisionRecord(
                id=decision.id,
                user_id=user_id,
                run_id=run.id,
                market_id=decision.market_id,
                slug=decision.slug,
                market_title=decision.market_title,
                side=decision.side,
                decision=decision.decision,
                risk_status=decision.risk_status,
                edge_pp=decision.edge_pp,
                score=decision.score,
                payload={},
            )
            apply_decision_to_record(record, decision, user_id=user_id)
            self.session.add(record)
        await self.session.flush()
        return len(decisions)

    async def list_runs(self, user_id: int, *, limit: int | None = None) -> list[BullpenAutoLiveRun]:
        query = (
            select(PolymarketAutoLiveRunRecord)
            .where(PolymarketAutoLiveRunRecord.user_id == user_id)
            .order_by(
                desc(PolymarketAutoLiveRunRecord.started_at),
                desc(PolymarketAutoLiveRunRecord.created_at),
            )
        )
        if limit is not None:
            query = query.limit(limit)
        rows = (await self.session.execute(query)).scalars().all()
        return [record_to_run(row) for row in rows]

    async def list_decisions(
        self, user_id: int, *, limit: int | None = None
    ) -> list[BullpenAutoLiveDecision]:
        query = (
            select(PolymarketAutoLiveDecisionRecord)
            .where(PolymarketAutoLiveDecisionRecord.user_id == user_id)
            .order_by(
                desc(PolymarketAutoLiveDecisionRecord.created_at),
                desc(PolymarketAutoLiveDecisionRecord.updated_at),
            )
        )
        if limit is not None:
            query = query.limit(limit)
        rows = (await self.session.execute(query)).scalars().all()
        decisions: list[BullpenAutoLiveDecision] = []
        for row in rows:
            try:
                decisions.append(record_to_decision(row))
            except ValidationError as exc:
                logger.warning(
                    "Skipping malformed Auto-Live decision %s during async load: %s",
                    _record_id(row),
                    exc,
                )
        return decisions


class SyncPolymarketAutoLiveRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def get_settings_record(self, user_id: int) -> PolymarketAutoLiveSettingsRecord | None:
        return self.session.get(PolymarketAutoLiveSettingsRecord, user_id)

    def get_state_record(self, user_id: int) -> PolymarketAutoLiveStateRecord | None:
        return self.session.get(PolymarketAutoLiveStateRecord, user_id)

    def save_settings(self, user_id: int, settings: BullpenAutoLiveSettings) -> None:
        record = self.get_settings_record(user_id)
        if record is None:
            record = PolymarketAutoLiveSettingsRecord(user_id=user_id, payload={})
            self.session.add(record)
        apply_settings_to_record(record, settings)

    def save_state(self, user_id: int, state: BullpenAutoLiveState) -> None:
        record = self.get_state_record(user_id)
        if record is None:
            record = PolymarketAutoLiveStateRecord(
                user_id=user_id,
                running=False,
                paused=False,
                status=state.status,
                mode=state.mode,
                payload={},
            )
            self.session.add(record)
        apply_state_to_record(record, state)

    def get_running_run_record(self, user_id: int) -> PolymarketAutoLiveRunRecord | None:
        query = (
            select(PolymarketAutoLiveRunRecord)
            .where(PolymarketAutoLiveRunRecord.user_id == user_id)
            .where(PolymarketAutoLiveRunRecord.status == "running")
            .order_by(
                desc(PolymarketAutoLiveRunRecord.started_at),
                desc(PolymarketAutoLiveRunRecord.created_at),
            )
            .limit(1)
        )
        return self.session.execute(query).scalar_one_or_none()

    def save_run(self, user_id: int, run: BullpenAutoLiveRun) -> None:
        # See the async counterpart: workers retain a long-lived session while
        # heartbeats use short independent transactions.  A fresh row lock
        # serializes the complete JSON write with heartbeat persistence.
        execute = getattr(self.session, "execute", None)
        if callable(execute):
            record = (
                execute(
                    select(PolymarketAutoLiveRunRecord)
                    .where(PolymarketAutoLiveRunRecord.id == run.id)
                    .with_for_update()
                    .execution_options(populate_existing=True, autoflush=False)
                )
                .scalar_one_or_none()
            )
        else:
            # See the async fallback above. Production SyncSession always
            # supports ``execute`` and therefore always obtains the row lock.
            record = self.session.get(PolymarketAutoLiveRunRecord, run.id)
        if record is None:
            record = PolymarketAutoLiveRunRecord(
                id=run.id,
                user_id=user_id,
                status=run.status,
                triggered_by=run.triggered_by,
                dry_run=run.dry_run,
                started_at=_parse_datetime(run.started_at) or utc_now(),
                summary=run.summary,
                payload={},
            )
            self.session.add(record)
        apply_run_to_record(record, run, user_id=user_id)

    def get_run(self, run_id: str) -> BullpenAutoLiveRun | None:
        record = self.session.get(PolymarketAutoLiveRunRecord, run_id)
        return record_to_run(record) if record is not None else None

    def get_run_fresh(self, run_id: str) -> BullpenAutoLiveRun | None:
        """Load a run outside the worker identity map.

        A long-running worker keeps one SQLAlchemy session open.  A normal
        ``Session.get`` can therefore return its original running copy after a
        separate API request has already cancelled the run.
        """
        record = self.session.execute(
            select(PolymarketAutoLiveRunRecord)
            .where(PolymarketAutoLiveRunRecord.id == run_id)
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
        return record_to_run(record) if record is not None else None

    def get_run_for_update(self, run_id: str) -> BullpenAutoLiveRun | None:
        """Refresh and lock a run before a worker writes new progress."""
        record = self.session.execute(
            select(PolymarketAutoLiveRunRecord)
            .where(PolymarketAutoLiveRunRecord.id == run_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        ).scalar_one_or_none()
        return record_to_run(record) if record is not None else None

    def count_decisions_by_run(self, run_ids: Sequence[str]) -> dict[str, int]:
        if not run_ids:
            return {}
        rows = self.session.execute(
            select(
                PolymarketAutoLiveDecisionRecord.run_id,
                func.count(PolymarketAutoLiveDecisionRecord.id),
            )
            .where(PolymarketAutoLiveDecisionRecord.run_id.in_(tuple(run_ids)))
            .group_by(PolymarketAutoLiveDecisionRecord.run_id)
        ).all()
        return {str(run_id): int(count) for run_id, count in rows}

    def replace_run_decisions(
        self,
        user_id: int,
        run_id: str,
        decisions: Iterable[BullpenAutoLiveDecision],
    ) -> None:
        existing = self.session.execute(
            select(PolymarketAutoLiveDecisionRecord).where(
                PolymarketAutoLiveDecisionRecord.run_id == run_id
            )
        ).scalars().all()
        for row in existing:
            self.session.delete(row)

        for decision in decisions:
            record = PolymarketAutoLiveDecisionRecord(
                id=decision.id,
                user_id=user_id,
                run_id=run_id,
                market_id=decision.market_id,
                slug=decision.slug,
                market_title=decision.market_title,
                side=decision.side,
                decision=decision.decision,
                risk_status=decision.risk_status,
                edge_pp=decision.edge_pp,
                score=decision.score,
                payload={},
            )
            apply_decision_to_record(record, decision, user_id=user_id)
            self.session.add(record)

    def replace_run_decisions_from_stage3_payload(
        self,
        user_id: int,
        run: BullpenAutoLiveRun,
    ) -> int:
        decisions = extract_stage3_decisions_from_run(run)
        if decisions is None:
            return 0
        self.replace_run_decisions(user_id, run.id, decisions)
        return len(decisions)

    def list_runs(self, user_id: int, *, limit: int | None = None) -> list[BullpenAutoLiveRun]:
        query = (
            select(PolymarketAutoLiveRunRecord)
            .where(PolymarketAutoLiveRunRecord.user_id == user_id)
            .order_by(
                desc(PolymarketAutoLiveRunRecord.started_at),
                desc(PolymarketAutoLiveRunRecord.created_at),
            )
        )
        if limit is not None:
            query = query.limit(limit)
        rows = self.session.execute(query).scalars().all()
        return [record_to_run(row) for row in rows]

    def list_decisions(
        self, user_id: int, *, limit: int | None = None
    ) -> list[BullpenAutoLiveDecision]:
        query = (
            select(PolymarketAutoLiveDecisionRecord)
            .where(PolymarketAutoLiveDecisionRecord.user_id == user_id)
            .order_by(
                desc(PolymarketAutoLiveDecisionRecord.created_at),
                desc(PolymarketAutoLiveDecisionRecord.updated_at),
            )
        )
        if limit is not None:
            query = query.limit(limit)
        rows = self.session.execute(query).scalars().all()
        decisions: list[BullpenAutoLiveDecision] = []
        for row in rows:
            try:
                decisions.append(record_to_decision(row))
            except ValidationError as exc:
                logger.warning(
                    "Skipping malformed Auto-Live decision %s during sync load: %s",
                    _record_id(row),
                    exc,
                )
        return decisions

    def list_open_position_records(
        self, user_id: int
    ) -> list[PolymarketAutoLivePositionRecord]:
        return self.session.execute(active_position_query(user_id)).scalars().all()

    def replace_positions(
        self,
        user_id: int,
        positions: list["PositionSnapshot"],
    ) -> None:
        from app.domains.polymarket_auto_live.engine import PositionSnapshot

        existing = self.list_open_position_records(user_id)
        for row in existing:
            self.session.delete(row)

        for position in positions:
            if not isinstance(position, PositionSnapshot):
                continue
            self.session.add(
                PolymarketAutoLivePositionRecord(
                    user_id=user_id,
                    market_id=position.market_id,
                    slug=position.slug,
                    market_title=position.market_title,
                    market_url=position.market_url,
                    theme=position.theme,
                    side=position.side,
                    exposure_usd=position.exposure_usd,
                    shares=position.shares,
                    average_price_cents=position.average_price_cents,
                    opened_at=position.opened_at,
                    closed_at=None,
                    payload={
                        "market_id": position.market_id,
                        "slug": position.slug,
                        "condition_id": position.condition_id,
                        "market_title": position.market_title,
                        "market_url": position.market_url,
                        "theme": position.theme,
                        "side": position.side,
                        "exposure_usd": position.exposure_usd,
                        "shares": position.shares,
                        "average_price_cents": position.average_price_cents,
                        "close_time": position.close_time,
                        "current_price_cents": position.current_price_cents,
                        "current_yes_odds": position.current_yes_odds,
                        "current_no_odds": position.current_no_odds,
                        "best_bid_cents": position.best_bid_cents,
                        "best_ask_cents": position.best_ask_cents,
                        "price_history": [
                            snapshot.model_dump(mode="json")
                            for snapshot in position.price_history
                        ],
                        "exit_signals": [
                            signal.model_dump(mode="json")
                            for signal in position.exit_signals
                        ],
                        "exit_state": position.exit_state,
                        "estimated_freeable_value_usd": position.estimated_freeable_value_usd,
                        "opened_at": position.opened_at.astimezone(UTC).isoformat(),
                        "updated_at": position.updated_at.astimezone(UTC).isoformat(),
                    },
                )
            )
