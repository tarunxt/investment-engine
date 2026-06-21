from __future__ import annotations

from datetime import UTC, datetime
from typing import Iterable

from sqlalchemy import Select, desc, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

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
    return BullpenAutoLiveDecision.model_validate(payload)


def apply_settings_to_record(
    record: PolymarketAutoLiveSettingsRecord,
    settings: BullpenAutoLiveSettings,
) -> None:
    record.payload = settings_to_record_payload(settings)


def apply_state_to_record(
    record: PolymarketAutoLiveStateRecord,
    state: BullpenAutoLiveState,
) -> None:
    record.running = state.running
    record.paused = state.paused
    record.status = state.status
    record.mode = state.mode
    record.last_run_at = _parse_datetime(state.last_run_at)
    record.next_run_at = _parse_datetime(state.next_run_at)
    record.payload = state_to_record_payload(state)


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
    record.payload = run_to_record_payload(run)


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
        self, user_id: int
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
        return (await self.session.execute(query)).scalar_one_or_none()

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
        return [record_to_decision(row) for row in rows]


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
        return [record_to_decision(row) for row in rows]

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
                        "market_title": position.market_title,
                        "market_url": position.market_url,
                        "theme": position.theme,
                        "side": position.side,
                        "exposure_usd": position.exposure_usd,
                        "shares": position.shares,
                        "average_price_cents": position.average_price_cents,
                        "opened_at": position.opened_at.astimezone(UTC).isoformat(),
                        "updated_at": position.updated_at.astimezone(UTC).isoformat(),
                    },
                )
            )
