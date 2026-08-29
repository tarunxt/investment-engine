from __future__ import annotations

from datetime import UTC, datetime
from math import ceil
from types import SimpleNamespace
from typing import TYPE_CHECKING, Iterable, Mapping, Sequence

from pydantic import ValidationError
from sqlalchemy import Select, and_, desc, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.domains.polymarket_auto_live.console_projection import (
    CONSOLE_HISTORY_MAX_SIZE,
    CONSOLE_PROJECTION_VERSION,
    build_decision_console_projection,
    build_history_item,
    build_run_console_projection,
    build_verified_stage1_portfolio_snapshot,
    canonical_workflow_stage_results,
    projected_run_payload,
    workflow_stage_key,
)
from app.domains.polymarket_auto_live.console_profile import llm_returns_per_day
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveDecisionRecord,
    PolymarketAutoLiveOrderIntentRecord,
    PolymarketAutoLivePositionRecord,
    PolymarketAutoLiveRunRecord,
    PolymarketAutoLiveSettingsRecord,
    PolymarketAutoLiveStateRecord,
)
from app.domains.polymarket_auto_live.schemas import (
    BullpenAutoLiveDecision,
    BullpenAutoLiveEventTrend,
    BullpenAutoLiveEventTrendsResponse,
    BullpenAutoLiveHistoryPage,
    BullpenAutoLiveLlmOutput,
    BullpenAutoLiveRun,
    BullpenAutoLiveSettings,
    BullpenAutoLiveStageResult,
    BullpenAutoLiveState,
    BullpenAutoLiveVerifiedPortfolioSnapshot,
)

logger = get_logger("app.domains.polymarket_auto_live.repository")


def _event_trend_llm_outputs(value: object) -> list[BullpenAutoLiveLlmOutput]:
    """Validate the bounded LLM-output slice selected from a decision payload."""
    if not isinstance(value, list):
        return []

    outputs: list[BullpenAutoLiveLlmOutput] = []
    for item in value:
        try:
            outputs.append(BullpenAutoLiveLlmOutput.model_validate(item))
        except ValidationError as exc:
            logger.warning("Skipping malformed Auto-Live trend LLM output: %s", exc)
    return outputs


if TYPE_CHECKING:
    from app.domains.polymarket_auto_live.engine import PositionSnapshot

VALID_AUTO_LIVE_STATUSES = {
    "running",
    "paused",
    "stopped",
    "error",
    "not-configured",
}
ACTIVE_AUTO_LIVE_RUN_STATUSES = ("running", "confirming")
TERMINAL_AUTO_LIVE_INTENT_STATUSES = frozenset(
    {
        "CONFIRMED",
        "FILLED",
        "DEFERRED",
        "CANCELLED",
        "FAILED_PERMANENT",
        "REJECTED",
        "TIMED_OUT",
    }
)

LEGACY_AUTO_LIVE_STATUS_MAP = {
    "idle": "stopped",
    "not_configured": "not-configured",
    "not configured": "not-configured",
    "": "not-configured",
}


def utc_now() -> datetime:
    return datetime.now(UTC)


def _has_nonterminal_intent(*, user_id: int):
    intent = PolymarketAutoLiveOrderIntentRecord
    run = PolymarketAutoLiveRunRecord
    return exists(
        select(1)
        .select_from(intent)
        .where(intent.user_id == user_id)
        .where(intent.run_id == run.id)
        .where(intent.status.not_in(TERMINAL_AUTO_LIVE_INTENT_STATUSES))
    )


def _active_run_filter(*, user_id: int):
    """Keep legacy orphan ``confirming`` rows from becoming active forever."""

    run = PolymarketAutoLiveRunRecord
    return or_(
        run.status == "running",
        and_(
            run.status == "confirming",
            _has_nonterminal_intent(user_id=user_id),
        ),
    )


def _dashboard_relevant_run_filter(*, user_id: int):
    run = PolymarketAutoLiveRunRecord
    return or_(
        run.status != "confirming",
        _has_nonterminal_intent(user_id=user_id),
    )


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


def _event_trend_returns_per_day(decision: BullpenAutoLiveDecision) -> float | None:
    """Return the saved value, or rebuild it from the latest scan's frozen inputs."""
    persisted = next(
        (
            result.outputs.get("returns_per_day")
            for result in reversed(decision.stage_results)
            if isinstance(result.outputs.get("returns_per_day"), (int, float))
        ),
        None,
    )
    if persisted is not None:
        return float(persisted)

    as_of = _parse_datetime(decision.updated_at) or _parse_datetime(decision.created_at)
    if as_of is None:
        return None
    return llm_returns_per_day(
        llm_yes_odds=decision.fair_yes_probability_pct,
        llm_no_odds=decision.fair_no_probability_pct,
        close_time=decision.close_time,
        now=as_of,
        current_yes_odds=decision.current_yes_odds,
        current_no_odds=decision.current_no_odds,
    )


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


def projected_row_to_run(row: object) -> tuple[BullpenAutoLiveRun, bool]:
    payload, projection_available = projected_run_payload(
        projection=getattr(row, "console_projection", None),
        id=str(getattr(row, "id")),
        triggered_by=str(getattr(row, "triggered_by")),
        status=str(getattr(row, "status")),
        dry_run=bool(getattr(row, "dry_run")),
        started_at=_isoformat(getattr(row, "started_at")) or utc_now().isoformat(),
        completed_at=_isoformat(getattr(row, "completed_at")),
        summary=str(getattr(row, "summary")),
        live_execution_requested=bool(
            getattr(row, "live_execution_requested", False)
        ),
        live_execution_attempted=bool(
            getattr(row, "live_execution_attempted", False)
        ),
        decisions_count=int(getattr(row, "decisions_count", 0) or 0),
        orders_planned=int(getattr(row, "orders_planned", 0) or 0),
        orders_submitted=int(getattr(row, "orders_submitted", 0) or 0),
        error_message=getattr(row, "error_message", None),
    )
    return BullpenAutoLiveRun.model_validate(payload), projection_available


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


def projected_row_to_decision(row: object) -> BullpenAutoLiveDecision:
    projection = getattr(row, "console_projection", None)
    if not isinstance(projection, dict):
        raise ValueError("decision console projection is unavailable")
    payload = projection.copy()
    payload.update(
        {
            "id": str(getattr(row, "id")),
            "run_id": str(getattr(row, "run_id")),
            "market_id": str(getattr(row, "market_id")),
            "slug": getattr(row, "slug", None),
            "market_title": str(getattr(row, "market_title")),
            "side": str(getattr(row, "side")),
            "decision": str(getattr(row, "decision")),
            "risk_status": str(getattr(row, "risk_status")),
            "edge_pp": float(getattr(row, "edge_pp", 0) or 0),
            "score": float(getattr(row, "score", 0) or 0),
            "created_at": _isoformat(getattr(row, "created_at")),
            "updated_at": _isoformat(getattr(row, "updated_at")),
        }
    )
    return BullpenAutoLiveDecision.model_validate(payload)


def extract_stage3_decisions_from_run(
    run: BullpenAutoLiveRun,
) -> list[BullpenAutoLiveDecision] | None:
    invest_stage = next(
        (
            stage
            for stage in canonical_workflow_stage_results(run.stage_results)
            if workflow_stage_key(stage) == "invest"
        ),
        None,
    )
    if invest_stage is None:
        return None

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
        # The containing durable run is authoritative.  A stale or malformed
        # embedded row must never be able to move a recovered decision onto a
        # different run (and potentially a different user's run).
        payload["run_id"] = run.id
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
    if record.id != run.id or record.user_id != user_id:
        raise ValueError("Auto-Live run ownership mismatch.")
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
    record.console_projection = build_run_console_projection(run)
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
    owning_run_id: str | None = None,
) -> None:
    canonical_run_id = owning_run_id or decision.run_id
    if (
        record.id != decision.id
        or record.user_id != user_id
        or record.run_id != canonical_run_id
    ):
        raise ValueError("Auto-Live decision ownership mismatch.")
    if decision.run_id != canonical_run_id:
        decision = decision.model_copy(update={"run_id": canonical_run_id})
    record.id = decision.id
    record.user_id = user_id
    record.run_id = canonical_run_id
    record.market_id = decision.market_id
    record.slug = decision.slug
    record.market_title = decision.market_title
    record.side = decision.side
    record.decision = decision.decision
    record.risk_status = decision.risk_status
    record.edge_pp = decision.edge_pp
    record.score = decision.score
    record.console_projection = build_decision_console_projection(decision)
    record.payload = decision_to_record_payload(decision)


def visible_auto_live_decision_filter():
    """Exclude durable decision rows superseded by run reconciliation."""

    record = PolymarketAutoLiveDecisionRecord
    return (
        func.coalesce(
            record.payload["_console_reconciliation_state"].as_string(),
            "active",
        )
        != "superseded"
    )


def _visible_decision_filter():
    """Backward-compatible private alias for existing repository queries."""

    return visible_auto_live_decision_filter()


def _mark_decision_superseded(
    record: PolymarketAutoLiveDecisionRecord,
) -> None:
    payload = _payload_or_default(record.payload)
    payload["_console_reconciliation_state"] = "superseded"
    payload["_console_superseded_at"] = utc_now().isoformat()
    record.payload = payload
    # Keep the immutable decision and durable FK parent, but remove it from
    # bounded live reads so reconstructed Stage 3 payloads cannot show both
    # old and replacement decisions for the same run.
    record.console_projection = None


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
            .where(_active_run_filter(user_id=user_id))
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
                .where(_active_run_filter(user_id=user_id))
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
                .where(_visible_decision_filter())
                .group_by(PolymarketAutoLiveDecisionRecord.run_id)
            )
        ).all()
        return {str(run_id): int(count) for run_id, count in rows}

    async def list_visible_decision_id_sets_by_run(
        self,
        user_id: int,
        expected_sizes_by_run: Mapping[str, int],
    ) -> dict[str, set[str]]:
        """Return bounded current decision identity for terminal run repair.

        Counts cannot detect an equal-size replacement or an over-counted
        stale row. Fetching the canonical payload size plus one row detects
        both cases without allowing a corrupt run to make history polling
        hydrate an unbounded decision table.
        """

        normalized_expected_sizes = {
            str(run_id): max(0, int(expected_size))
            for run_id, expected_size in expected_sizes_by_run.items()
        }
        if not normalized_expected_sizes:
            return {}
        decision_ids: dict[str, set[str]] = {}
        for run_id, expected_size in normalized_expected_sizes.items():
            rows = (
                await self.session.execute(
                    select(PolymarketAutoLiveDecisionRecord.id)
                    .where(
                        PolymarketAutoLiveDecisionRecord.user_id == user_id
                    )
                    .where(
                        PolymarketAutoLiveDecisionRecord.run_id == run_id
                    )
                    .where(_visible_decision_filter())
                    .order_by(
                        desc(PolymarketAutoLiveDecisionRecord.created_at),
                        desc(PolymarketAutoLiveDecisionRecord.updated_at),
                        desc(PolymarketAutoLiveDecisionRecord.id),
                    )
                    .limit(expected_size + 1)
                )
            ).scalars().all()
            decision_ids[run_id] = {
                str(decision_id) for decision_id in rows
            }
        return decision_ids

    async def replace_run_decisions_from_stage3_payload(
        self,
        user_id: int,
        run: BullpenAutoLiveRun,
    ) -> int:
        decisions = extract_stage3_decisions_from_run(run)
        if decisions is None:
            return 0
        if not await self.run_exists_for_user(user_id, run.id):
            raise ValueError("Auto-Live run not found.")

        existing = {
            row.id: row
            for row in (
                await self.session.execute(
                    select(PolymarketAutoLiveDecisionRecord).where(
                        PolymarketAutoLiveDecisionRecord.run_id == run.id
                    )
                )
            ).scalars().all()
        }

        incoming_ids = {decision.id for decision in decisions}
        for decision in decisions:
            record = existing.get(decision.id)
            if record is None:
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
                self.session.add(record)
            apply_decision_to_record(
                record,
                decision,
                user_id=user_id,
                owning_run_id=run.id,
            )
        for decision_id, record in existing.items():
            if decision_id not in incoming_ids:
                _mark_decision_superseded(record)
        # Never delete an existing decision during payload reconciliation.
        # Durable intents use ``decision_id ON DELETE SET NULL`` and must not
        # be cascade-deleted merely because a late/recovered payload contains
        # a different subset of decision rows.
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

    async def get_latest_projected_run(
        self,
        user_id: int,
    ) -> tuple[BullpenAutoLiveRun, bool, str] | None:
        """Read the newest console projection without selecting the TOAST payload."""

        record = PolymarketAutoLiveRunRecord
        row = (
            await self.session.execute(
                select(
                    record.id,
                    record.status,
                    record.triggered_by,
                    record.dry_run,
                    record.started_at,
                    record.completed_at,
                    record.live_execution_requested,
                    record.live_execution_attempted,
                    record.decisions_count,
                    record.orders_planned,
                    record.orders_submitted,
                    record.summary,
                    record.error_message,
                    record.console_projection,
                    record.updated_at,
                )
                .where(record.user_id == user_id)
                .where(_dashboard_relevant_run_filter(user_id=user_id))
                .order_by(desc(record.started_at), desc(record.created_at))
                .limit(1)
            )
        ).one_or_none()
        if row is None:
            return None
        run, projection_available = projected_row_to_run(row)
        return (
            run,
            projection_available,
            _isoformat(row.updated_at) or run.started_at,
        )

    async def get_projected_run_for_user(
        self,
        user_id: int,
        run_id: str,
    ) -> tuple[BullpenAutoLiveRun, bool, str] | None:
        """Read one exact bounded projection without selecting the TOAST payload."""

        record = PolymarketAutoLiveRunRecord
        row = (
            await self.session.execute(
                select(
                    record.id,
                    record.status,
                    record.triggered_by,
                    record.dry_run,
                    record.started_at,
                    record.completed_at,
                    record.live_execution_requested,
                    record.live_execution_attempted,
                    record.decisions_count,
                    record.orders_planned,
                    record.orders_submitted,
                    record.summary,
                    record.error_message,
                    record.console_projection,
                    record.updated_at,
                )
                .where(record.user_id == user_id)
                .where(record.id == run_id)
                .limit(1)
            )
        ).one_or_none()
        if row is None:
            return None
        run, projection_available = projected_row_to_run(row)
        return (
            run,
            projection_available,
            _isoformat(row.updated_at) or run.started_at,
        )

    async def get_console_run_snapshot_for_user(
        self,
        user_id: int,
        run_id: str,
        *,
        decision_limit: int,
        visible_id_limit: int,
    ) -> (
        tuple[
            BullpenAutoLiveRun,
            bool,
            str,
            list[BullpenAutoLiveDecision],
            list[str],
        ]
        | None
    ):
        """Read the exact run and its current decisions in one DB snapshot.

        PostgreSQL's default READ COMMITTED isolation gives each statement a
        new snapshot.  Fetching the run, rows, and IDs with separate SELECTs
        could therefore combine two Stage 3 reconciliation generations.  A
        single bounded CTE/outer-join statement makes the projection coherent
        without loading either immutable full payload.
        """

        normalized_decision_limit = max(1, min(decision_limit, 50))
        normalized_visible_id_limit = max(1, min(visible_id_limit, 201))
        row_limit = max(
            normalized_decision_limit,
            normalized_visible_id_limit,
        )
        run_record = PolymarketAutoLiveRunRecord
        decision_record = PolymarketAutoLiveDecisionRecord
        exact_run = (
            select(
                run_record.id,
                run_record.status,
                run_record.triggered_by,
                run_record.dry_run,
                run_record.started_at,
                run_record.completed_at,
                run_record.live_execution_requested,
                run_record.live_execution_attempted,
                run_record.decisions_count,
                run_record.orders_planned,
                run_record.orders_submitted,
                run_record.summary,
                run_record.error_message,
                run_record.console_projection,
                run_record.updated_at,
            )
            .where(run_record.user_id == user_id)
            .where(run_record.id == run_id)
            .limit(1)
            .cte("exact_console_run")
        )
        rows = (
            await self.session.execute(
                select(
                    *exact_run.c,
                    decision_record.id.label("decision_record_id"),
                    decision_record.run_id.label("decision_record_run_id"),
                    decision_record.market_id.label("decision_record_market_id"),
                    decision_record.slug.label("decision_record_slug"),
                    decision_record.market_title.label(
                        "decision_record_market_title"
                    ),
                    decision_record.side.label("decision_record_side"),
                    decision_record.decision.label("decision_record_action"),
                    decision_record.risk_status.label(
                        "decision_record_risk_status"
                    ),
                    decision_record.edge_pp.label("decision_record_edge_pp"),
                    decision_record.score.label("decision_record_score"),
                    decision_record.console_projection.label(
                        "decision_record_console_projection"
                    ),
                    decision_record.created_at.label(
                        "decision_record_created_at"
                    ),
                    decision_record.updated_at.label(
                        "decision_record_updated_at"
                    ),
                )
                .select_from(
                    exact_run.outerjoin(
                        decision_record,
                        and_(
                            decision_record.user_id == user_id,
                            decision_record.run_id == exact_run.c.id,
                            decision_record.console_projection.is_not(None),
                            _visible_decision_filter(),
                        ),
                    )
                )
                .order_by(
                    desc(decision_record.created_at).nulls_last(),
                    desc(decision_record.updated_at).nulls_last(),
                    desc(decision_record.id).nulls_last(),
                )
                .limit(row_limit)
            )
        ).all()
        if not rows:
            return None

        first_row = rows[0]
        run, projection_available = projected_row_to_run(first_row)
        decisions: list[BullpenAutoLiveDecision] = []
        visible_decision_ids: list[str] = []
        for row in rows:
            decision_id = row.decision_record_id
            if decision_id is None:
                continue
            visible_decision_ids.append(str(decision_id))
            if len(visible_decision_ids) > normalized_decision_limit:
                continue
            projected_row = SimpleNamespace(
                id=decision_id,
                run_id=row.decision_record_run_id,
                market_id=row.decision_record_market_id,
                slug=row.decision_record_slug,
                market_title=row.decision_record_market_title,
                side=row.decision_record_side,
                decision=row.decision_record_action,
                risk_status=row.decision_record_risk_status,
                edge_pp=row.decision_record_edge_pp,
                score=row.decision_record_score,
                console_projection=row.decision_record_console_projection,
                created_at=row.decision_record_created_at,
                updated_at=row.decision_record_updated_at,
            )
            try:
                decisions.append(projected_row_to_decision(projected_row))
            except (ValidationError, ValueError) as exc:
                logger.warning(
                    "Skipping malformed Auto-Live decision console projection %s: %s",
                    decision_id,
                    exc,
                )
        return (
            run,
            projection_available,
            _isoformat(first_row.updated_at) or run.started_at,
            decisions,
            visible_decision_ids,
        )

    async def get_latest_verified_portfolio_snapshot(
        self,
        user_id: int,
    ) -> BullpenAutoLiveVerifiedPortfolioSnapshot | None:
        """Read one Stage 1-only legacy fallback without hydrating many runs."""

        record = PolymarketAutoLiveRunRecord
        stage = record.console_projection["stage_results"][0]
        outputs = stage["outputs"]
        wallet_status = func.lower(
            func.coalesce(
                outputs["wallet_snapshot_status"].as_string(),
                "",
            )
        )
        wallet_freshness = func.lower(
            func.coalesce(
                outputs["wallet_snapshot_freshness_state"].as_string(),
                outputs["wallet_freshness_state"].as_string(),
                "",
            )
        )
        wallet_refresh_error = func.btrim(
            func.coalesce(
                outputs["wallet_refresh_error"].as_string(),
                "",
            )
        )
        wallet_market_enrichment_error = func.btrim(
            func.coalesce(
                outputs["wallet_market_enrichment_error"].as_string(),
                "",
            )
        )
        row = (
            await self.session.execute(
                select(
                    record.id,
                    record.status,
                    record.triggered_by,
                    record.dry_run,
                    record.started_at,
                    record.completed_at,
                    record.live_execution_requested,
                    record.live_execution_attempted,
                    record.decisions_count,
                    record.orders_planned,
                    record.orders_submitted,
                    record.summary,
                    record.error_message,
                    record.console_projection,
                    record.updated_at,
                )
                .where(record.user_id == user_id)
                .where(record.console_projection.is_not(None))
                .where(_dashboard_relevant_run_filter(user_id=user_id))
                .where(
                    record.console_projection["version"].as_integer()
                    == CONSOLE_PROJECTION_VERSION
                )
                .where(
                    outputs["workflow_stage_key"].as_string() == "scan"
                )
                .where(stage["status"].as_string().in_(("pass", "warning")))
                .where(
                    or_(
                        stage["completed_at"].as_string().is_not(None),
                        outputs["phase_status"]
                        .as_string()
                        .in_(("completed",)),
                    )
                )
                .where(outputs["active_positions_found"].is_not(None))
                .where(
                    func.coalesce(
                        outputs["stage2_candidate_only"].as_boolean(),
                        False,
                    ).is_(False)
                )
                .where(
                    func.coalesce(
                        outputs[
                            "blocked_by_stage1_wallet_refresh"
                        ].as_boolean(),
                        False,
                    ).is_(False)
                )
                .where(wallet_refresh_error == "")
                .where(wallet_market_enrichment_error == "")
                .where(wallet_status == "fresh")
                .where(wallet_freshness == "fresh")
                .order_by(desc(record.started_at), desc(record.created_at))
                .limit(1)
            )
        ).one_or_none()
        if row is None:
            return None
        try:
            run, projection_available = projected_row_to_run(row)
        except (ValidationError, ValueError) as exc:
            logger.warning(
                "Skipping malformed Auto-Live portfolio projection %s: %s",
                getattr(row, "id", "unknown"),
                exc,
            )
            return None
        if not projection_available:
            return None
        return build_verified_stage1_portfolio_snapshot(run)

    async def list_run_history_page(
        self,
        user_id: int,
        *,
        page: int,
        size: int,
    ) -> BullpenAutoLiveHistoryPage:
        """Return bounded history rows without loading ``run.payload``."""

        normalized_page = max(1, page)
        normalized_size = max(1, min(size, CONSOLE_HISTORY_MAX_SIZE))
        record = PolymarketAutoLiveRunRecord
        total = int(
            await self.session.scalar(
                select(func.count())
                .select_from(record)
                .where(record.user_id == user_id)
            )
            or 0
        )
        rows = (
            await self.session.execute(
                select(
                    record.id,
                    record.status,
                    record.triggered_by,
                    record.dry_run,
                    record.started_at,
                    record.completed_at,
                    record.live_execution_requested,
                    record.live_execution_attempted,
                    record.decisions_count,
                    record.orders_planned,
                    record.orders_submitted,
                    record.summary,
                    record.error_message,
                    record.console_projection,
                    record.updated_at,
                )
                .where(record.user_id == user_id)
                .order_by(desc(record.started_at), desc(record.created_at))
                .offset((normalized_page - 1) * normalized_size)
                .limit(normalized_size)
            )
        ).all()
        items = []
        for row in rows:
            run, projection_available = projected_row_to_run(row)
            items.append(
                build_history_item(
                    run,
                    latest_update_at=_isoformat(row.updated_at) or run.started_at,
                    projection_available=projection_available,
                )
            )
        pages = ceil(total / normalized_size) if total else 0
        return BullpenAutoLiveHistoryPage(
            items=items,
            total=total,
            page=normalized_page,
            size=normalized_size,
            pages=pages,
            has_next=normalized_page < pages,
            generated_at=utc_now().isoformat(),
        )

    async def list_recent_event_trends(self, user_id: int, *, scan_count: int = 20) -> BullpenAutoLiveEventTrendsResponse:
        """Aggregate the latest Stage 2 LLM scans, with decision rows as fallback.

        The heatmap represents LLM scans, not only Stage 3 decisions. A run can
        finish Stage 2 successfully and legitimately produce no Stage 3 decision
        rows (candidate-only analysis, zero buys, or a later execution block).
        Reading only decision records therefore left the newest circle grey even
        though the LLM run had completed. Stage 2's durable reviewed-candidate
        rows are authoritative for each scan slot; compact decision projections
        remain useful as a backward-compatible fallback and for position metadata.
        """
        run = PolymarketAutoLiveRunRecord
        decision = PolymarketAutoLiveDecisionRecord
        normalized_scan_count = max(1, min(scan_count, 20))
        trend_generated_at = utc_now()
        returns_formula = record_to_settings(
            await self.get_settings_record(user_id)
        ).returns_per_day_formula
        run_rows = (await self.session.execute(
            select(
                run.id,
                run.console_projection["stage_results"].label("trend_stage_results"),
                run.started_at,
                run.completed_at,
                run.updated_at,
            )
            .where(run.user_id == user_id)
            .order_by(desc(run.started_at), desc(run.created_at))
            .limit(normalized_scan_count)
        )).all()
        run_ids = [str(row.id) for row in run_rows]
        if not run_ids:
            return BullpenAutoLiveEventTrendsResponse(
                scan_count=20,
                generated_at=utc_now().isoformat(),
            )

        run_index = {run_id: index for index, run_id in enumerate(run_ids)}
        event_scores: dict[str, dict[str, object]] = {}

        def as_record(value: object) -> dict[str, object]:
            return value if isinstance(value, dict) else {}

        def first_text(*values: object) -> str | None:
            for value in values:
                if isinstance(value, str) and value.strip():
                    return value.strip()
            return None

        def first_number(*values: object) -> float | None:
            for value in values:
                if isinstance(value, bool) or value is None:
                    continue
                if isinstance(value, (int, float)):
                    return float(value)
                if isinstance(value, str):
                    try:
                        return float(value.strip().replace("%", ""))
                    except ValueError:
                        continue
            return None

        def ensure_entry(market_id: str, title: str) -> dict[str, object]:
            entry = event_scores.setdefault(
                market_id,
                {
                    "title": title,
                    "scores": [None] * 20,
                    "sides": [None] * 20,
                    "timestamps": [None] * 20,
                    "llm_outputs": [[] for _ in range(20)],
                    "latest_stage2": None,
                    "latest_decision": None,
                },
            )
            if title:
                entry["title"] = title
            return entry

        # Stage 2 is the source of truth for the scan circles. Read the bounded
        # console projection rather than the immutable full run payload: the latter
        # can contain the complete market universe and provider evidence for every
        # scan, which makes this first-paint query exceed its browser budget.
        for run_row in run_rows:
            index = run_index[str(run_row.id)]
            raw_stages = run_row.trend_stage_results
            if not isinstance(raw_stages, list):
                continue
            llm_stage: BullpenAutoLiveStageResult | None = None
            for raw_stage in raw_stages:
                try:
                    stage = BullpenAutoLiveStageResult.model_validate(raw_stage)
                except ValidationError as exc:
                    logger.warning(
                        "Skipping malformed Auto-Live trend stage for run %s: %s",
                        run_row.id,
                        exc,
                    )
                    continue
                if workflow_stage_key(stage) == "llm":
                    llm_stage = stage
                    break
            if llm_stage is None:
                continue

            reviewed_rows = llm_stage.outputs.get("llm_reviewed_candidates")
            if not isinstance(reviewed_rows, list):
                continue
            stage_timestamp = first_text(
                llm_stage.completed_at,
                llm_stage.started_at,
                _isoformat(run_row.completed_at),
                _isoformat(run_row.updated_at),
                _isoformat(run_row.started_at),
            )
            for raw_candidate in reviewed_rows:
                if not isinstance(raw_candidate, dict):
                    continue
                candidate = raw_candidate
                prompt_inputs = as_record(candidate.get("llm_prompt_inputs"))
                prompt_market = as_record(prompt_inputs.get("market"))
                prepared = as_record(candidate.get("prepared_question_payload"))
                if not prepared:
                    prepared = as_record(prompt_inputs.get("question_payload"))

                market_id = first_text(
                    candidate.get("market_id"),
                    candidate.get("marketId"),
                    prepared.get("market_id"),
                    prompt_market.get("market_id"),
                    candidate.get("question_id"),
                    candidate.get("questionId"),
                    prepared.get("question_id"),
                    candidate.get("slug"),
                    prepared.get("slug"),
                    prompt_market.get("slug"),
                )
                if market_id is None:
                    continue
                title = first_text(
                    candidate.get("market_title"),
                    candidate.get("question"),
                    candidate.get("title"),
                    prepared.get("question"),
                    prepared.get("market_title"),
                    prompt_market.get("question"),
                    prompt_market.get("market_title"),
                    market_id,
                ) or market_id

                yes_score = first_number(
                    candidate.get("fair_yes_probability_pct"),
                    candidate.get("llm_yes_odds"),
                    candidate.get("yes_probability_pct"),
                )
                no_score = first_number(
                    candidate.get("fair_no_probability_pct"),
                    candidate.get("llm_no_odds"),
                    candidate.get("no_probability_pct"),
                )
                if yes_score is None and no_score is not None and 0 <= no_score <= 100:
                    yes_score = 100 - no_score
                if no_score is None and yes_score is not None and 0 <= yes_score <= 100:
                    no_score = 100 - yes_score
                if yes_score is None or no_score is None:
                    continue

                strongest = max(yes_score, no_score)
                strongest_side = "YES" if yes_score >= no_score else "NO"
                current_yes_odds = first_number(
                    candidate.get("current_yes_odds"),
                    candidate.get("current_yes_odds_pct"),
                    candidate.get("yes_price_pct"),
                    prompt_market.get("current_yes_odds"),
                    prepared.get("current_yes_odds"),
                )
                current_no_odds = first_number(
                    candidate.get("current_no_odds"),
                    candidate.get("current_no_odds_pct"),
                    candidate.get("no_price_pct"),
                    prompt_market.get("current_no_odds"),
                    prepared.get("current_no_odds"),
                )
                if (
                    current_no_odds is None
                    and current_yes_odds is not None
                    and 0 <= current_yes_odds <= 100
                ):
                    current_no_odds = 100 - current_yes_odds
                if (
                    current_yes_odds is None
                    and current_no_odds is not None
                    and 0 <= current_no_odds <= 100
                ):
                    current_yes_odds = 100 - current_no_odds

                timestamp = first_text(
                    candidate.get("events_summary_snapshot_timestamp"),
                    candidate.get("events_summary_updated_at"),
                    candidate.get("events_summary_calculated_at"),
                    candidate.get("calculation_timestamp"),
                    candidate.get("calculated_at"),
                    candidate.get("llm_completed_at"),
                    candidate.get("completed_at"),
                    candidate.get("llm_run_at"),
                    candidate.get("scanned_at"),
                    stage_timestamp,
                )
                llm_outputs = _event_trend_llm_outputs(candidate.get("llm_outputs"))
                entry = ensure_entry(market_id, title)
                scores = entry["scores"]
                if isinstance(scores, list) and (
                    scores[index] is None or strongest >= float(scores[index])
                ):
                    scores[index] = round(strongest, 2)
                    entry["sides"][index] = strongest_side
                    entry["timestamps"][index] = timestamp
                    entry["llm_outputs"][index] = llm_outputs
                    if index == 0:
                        exposure = first_number(
                            candidate.get("current_exposure_usd"),
                            candidate.get("exposure_usd"),
                        )
                        entry["latest_stage2"] = {
                            "market_url": first_text(
                                candidate.get("market_url"),
                                candidate.get("source_url"),
                                prepared.get("market_url"),
                                prompt_market.get("market_url"),
                            ),
                            "close_time": first_text(
                                candidate.get("close_time"),
                                candidate.get("end_date"),
                                prepared.get("close_time"),
                                prompt_market.get("close_time"),
                            ),
                            "current_yes_odds": current_yes_odds,
                            "current_no_odds": current_no_odds,
                            "llm_yes_odds": yes_score,
                            "llm_no_odds": no_score,
                            "returns_per_day": first_number(
                                candidate.get("returns_per_day")
                            ),
                            "is_active_position": bool(
                                exposure is not None and exposure > 0
                            ),
                            "active_position_side": first_text(
                                candidate.get("position_side"),
                                candidate.get("side"),
                            ),
                        }

        # Decision rows preserve legacy history and enrich the newest scan with
        # position metadata, but never overwrite a Stage 2 scan observation.
        rows = (await self.session.execute(select(
            decision.id, decision.run_id, decision.market_id, decision.slug,
            decision.market_title, decision.side, decision.decision,
            decision.risk_status, decision.edge_pp, decision.score,
            decision.console_projection,
            decision.console_projection["llm_outputs"].label("trend_llm_outputs"),
            decision.payload["llm_outputs"].label("trend_frozen_llm_outputs"),
            decision.created_at, decision.updated_at,
        ).where(decision.user_id == user_id).where(decision.run_id.in_(run_ids))
          .where(decision.console_projection.is_not(None)).where(_visible_decision_filter()))).all()
        for row in rows:
            try:
                projected = projected_row_to_decision(row)
            except (ValidationError, ValueError) as exc:
                logger.warning(
                    "Skipping malformed Auto-Live trend decision %s: %s",
                    getattr(row, "id", "unknown"),
                    exc,
                )
                continue
            index = run_index.get(str(row.run_id))
            if index is None:
                continue
            yes_score = (
                projected.fair_yes_probability_pct
                if projected.fair_yes_probability_pct is not None
                else projected.fair_probability_pct
            )
            no_score = (
                projected.fair_no_probability_pct
                if projected.fair_no_probability_pct is not None
                else 100 - projected.fair_probability_pct
            )
            strongest = max(yes_score, no_score)
            strongest_side = "YES" if yes_score >= no_score else "NO"
            entry = ensure_entry(projected.market_id, projected.market_title)
            scores = entry["scores"]
            frozen_llm_outputs = _event_trend_llm_outputs(
                getattr(row, "trend_frozen_llm_outputs", None)
            )
            projected_llm_outputs = _event_trend_llm_outputs(
                row.trend_llm_outputs
            )
            decision_llm_outputs = frozen_llm_outputs or projected_llm_outputs
            if isinstance(scores, list) and scores[index] is None:
                scores[index] = round(strongest, 2)
                entry["sides"][index] = strongest_side
                entry["timestamps"][index] = projected.updated_at or projected.created_at
            # A Stage-2 projection created before per-model trend retention can
            # already contain the score while its output array is empty. Enrich
            # that scan from the immutable decision payload without replacing a
            # newer authoritative Stage-2 breakdown.
            if not entry["llm_outputs"][index] and decision_llm_outputs:
                entry["llm_outputs"][index] = decision_llm_outputs
            if index == 0:
                entry["latest_decision"] = projected

        events: list[BullpenAutoLiveEventTrend] = []
        for market_id, entry in event_scores.items():
            latest_stage2 = (
                entry["latest_stage2"]
                if isinstance(entry.get("latest_stage2"), dict)
                else {}
            )
            latest_decision = entry.get("latest_decision")
            if not isinstance(latest_decision, BullpenAutoLiveDecision):
                latest_decision = None

            def stage2_or_decision(key: str, decision_value: object) -> object:
                value = latest_stage2.get(key)
                return decision_value if value is None else value

            current_yes_odds = first_number(stage2_or_decision(
                "current_yes_odds",
                latest_decision.current_yes_odds if latest_decision else None,
            ))
            current_no_odds = first_number(stage2_or_decision(
                "current_no_odds",
                latest_decision.current_no_odds if latest_decision else None,
            ))
            llm_yes_odds = first_number(stage2_or_decision(
                "llm_yes_odds",
                latest_decision.fair_yes_probability_pct
                if latest_decision else None,
            ))
            llm_no_odds = first_number(stage2_or_decision(
                "llm_no_odds",
                latest_decision.fair_no_probability_pct
                if latest_decision else None,
            ))
            # Older compact projections retained the heatmap's strongest score
            # and side but truncated the corresponding Stage-2 candidate row.
            # Reconstruct the complementary consensus pair from those frozen
            # values so latest-scan coverage and Returns/day stay truthful.
            latest_score = first_number(entry["scores"][0])
            latest_side = first_text(entry["sides"][0])
            if latest_score is not None and 0 <= latest_score <= 100:
                if llm_yes_odds is None:
                    llm_yes_odds = (
                        latest_score if latest_side == "YES" else 100 - latest_score
                    )
                if llm_no_odds is None:
                    llm_no_odds = (
                        latest_score if latest_side == "NO" else 100 - latest_score
                    )
            close_time = first_text(stage2_or_decision(
                "close_time",
                latest_decision.close_time if latest_decision else None,
            ))
            is_claimable_position = bool(
                latest_stage2.get("is_claimable_position")
            )
            current_returns_per_day = (
                None
                if is_claimable_position
                else llm_returns_per_day(
                    llm_yes_odds=llm_yes_odds,
                    llm_no_odds=llm_no_odds,
                    close_time=close_time,
                    now=trend_generated_at,
                    current_yes_odds=current_yes_odds,
                    current_no_odds=current_no_odds,
                    formula=returns_formula,
                )
            )
            active_from_stage2 = bool(latest_stage2.get("is_active_position"))
            active_from_decision = bool(
                latest_decision is not None
                and latest_decision.current_exposure_usd > 0
            )
            events.append(BullpenAutoLiveEventTrend(
                market_id=market_id,
                market_title=str(entry["title"]),
                market_url=stage2_or_decision(
                    "market_url",
                    latest_decision.market_url if latest_decision else None,
                ),
                close_time=close_time,
                score=round(sum(
                    (entry["scores"][index] or 0) * weight
                    for index, weight in enumerate((1, 0.5, 0.25))
                ), 2),
                scan_scores=entry["scores"],
                scan_sides=entry["sides"],
                scan_timestamps=entry["timestamps"],
                scan_llm_outputs=entry["llm_outputs"],
                current_yes_odds=current_yes_odds,
                current_no_odds=current_no_odds,
                llm_yes_odds=llm_yes_odds,
                llm_no_odds=llm_no_odds,
                returns_per_day=current_returns_per_day,
                is_active_position=active_from_stage2 or active_from_decision,
                is_claimable_position=is_claimable_position,
                active_position_side=(
                    latest_stage2.get("active_position_side")
                    if active_from_stage2
                    else (
                        latest_decision.side
                        if active_from_decision and latest_decision is not None
                        else None
                    )
                ),
            ))

        events.sort(key=lambda event: (-event.score, event.market_title.casefold()))
        return BullpenAutoLiveEventTrendsResponse(
            events=events,
            scan_count=20,
            generated_at=trend_generated_at.isoformat(),
        )

    async def list_projected_decisions_for_run(
        self,
        user_id: int,
        run_id: str,
        *,
        limit: int = 25,
    ) -> list[BullpenAutoLiveDecision]:
        """Load compact decision rows for the active dashboard only."""

        record = PolymarketAutoLiveDecisionRecord
        rows = (
            await self.session.execute(
                select(
                    record.id,
                    record.run_id,
                    record.market_id,
                    record.slug,
                    record.market_title,
                    record.side,
                    record.decision,
                    record.risk_status,
                    record.edge_pp,
                    record.score,
                    record.console_projection,
                    record.created_at,
                    record.updated_at,
                )
                .where(record.user_id == user_id)
                .where(record.run_id == run_id)
                .where(record.console_projection.is_not(None))
                .where(_visible_decision_filter())
                .order_by(
                    desc(record.created_at),
                    desc(record.updated_at),
                    desc(record.id),
                )
                .limit(max(1, min(limit, 50)))
            )
        ).all()
        decisions: list[BullpenAutoLiveDecision] = []
        for row in rows:
            try:
                decisions.append(projected_row_to_decision(row))
            except (ValidationError, ValueError) as exc:
                logger.warning(
                    "Skipping malformed Auto-Live decision console projection %s: %s",
                    getattr(row, "id", "unknown"),
                    exc,
                )
        return decisions

    async def list_visible_decision_ids_for_run(
        self,
        user_id: int,
        run_id: str,
        *,
        limit: int = 201,
    ) -> list[str]:
        """Return bounded current decision identity without hydrating payloads."""

        record = PolymarketAutoLiveDecisionRecord
        rows = (
            await self.session.execute(
                select(record.id)
                .where(record.user_id == user_id)
                .where(record.run_id == run_id)
                .where(record.console_projection.is_not(None))
                .where(_visible_decision_filter())
                .order_by(
                    desc(record.created_at),
                    desc(record.updated_at),
                    desc(record.id),
                )
                .limit(max(1, min(limit, 201)))
            )
        ).scalars().all()
        return [str(decision_id) for decision_id in rows]

    async def list_decisions_for_run(
        self,
        user_id: int,
        run_id: str,
        *,
        limit: int = 200,
    ) -> list[BullpenAutoLiveDecision]:
        query = (
            select(PolymarketAutoLiveDecisionRecord)
            .where(PolymarketAutoLiveDecisionRecord.user_id == user_id)
            .where(PolymarketAutoLiveDecisionRecord.run_id == run_id)
            .where(_visible_decision_filter())
            .order_by(
                desc(PolymarketAutoLiveDecisionRecord.created_at),
                desc(PolymarketAutoLiveDecisionRecord.updated_at),
            )
            .limit(max(1, min(limit, 200)))
        )
        rows = (await self.session.execute(query)).scalars().all()
        decisions: list[BullpenAutoLiveDecision] = []
        for row in rows:
            try:
                decisions.append(record_to_decision(row))
            except ValidationError as exc:
                logger.warning(
                    "Skipping malformed Auto-Live decision %s during run detail load: %s",
                    _record_id(row),
                    exc,
                )
        return decisions

    async def run_exists_for_user(self, user_id: int, run_id: str) -> bool:
        """Check detail ownership without hydrating the large run payload."""

        record_id = await self.session.scalar(
            select(PolymarketAutoLiveRunRecord.id)
            .where(PolymarketAutoLiveRunRecord.user_id == user_id)
            .where(PolymarketAutoLiveRunRecord.id == run_id)
            .limit(1)
        )
        return record_id is not None

    async def list_decisions(
        self, user_id: int, *, limit: int | None = None
    ) -> list[BullpenAutoLiveDecision]:
        query = (
            select(PolymarketAutoLiveDecisionRecord)
            .where(PolymarketAutoLiveDecisionRecord.user_id == user_id)
            .where(_visible_decision_filter())
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
            .where(_active_run_filter(user_id=user_id))
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
            .where(_visible_decision_filter())
            .group_by(PolymarketAutoLiveDecisionRecord.run_id)
        ).all()
        return {str(run_id): int(count) for run_id, count in rows}

    def replace_run_decisions(
        self,
        user_id: int,
        run_id: str,
        decisions: Iterable[BullpenAutoLiveDecision],
    ) -> None:
        decisions = list(decisions)
        owned_run_id = self.session.scalar(
            select(PolymarketAutoLiveRunRecord.id)
            .where(PolymarketAutoLiveRunRecord.user_id == user_id)
            .where(PolymarketAutoLiveRunRecord.id == run_id)
            .limit(1)
        )
        if owned_run_id is None:
            raise ValueError("Auto-Live run not found.")
        existing = {
            row.id: row
            for row in self.session.execute(
                select(PolymarketAutoLiveDecisionRecord).where(
                    PolymarketAutoLiveDecisionRecord.run_id == run_id
                )
            ).scalars().all()
        }

        incoming_ids = {decision.id for decision in decisions}
        for decision in decisions:
            record = existing.get(decision.id)
            if record is None:
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
                self.session.add(record)
            apply_decision_to_record(
                record,
                decision,
                user_id=user_id,
                owning_run_id=run_id,
            )
        for decision_id, record in existing.items():
            if decision_id not in incoming_ids:
                _mark_decision_superseded(record)
        # Preserve any existing decision rows and their durable intent lineage.
        # This method is intentionally idempotent/upsert-only despite its
        # legacy name.

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
            .where(_visible_decision_filter())
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
