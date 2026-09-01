from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload, selectinload

from app.domains.bullpen008.constants import (
    CELERY_QUEUE,
    CELERY_TASK_NAME,
    REDIS_PREFIX,
    RUN_LOCK_TTL_SECONDS,
    STAGE_VERSIONS,
    WORKFLOW_PROFILE,
)
from app.domains.bullpen008.models import (
    Bullpen008ActionPlanRecord,
    Bullpen008AlertRecord,
    Bullpen008ContingentExitActivationRecord,
    Bullpen008DrawdownEpisodeRecord,
    Bullpen008ExecutionIntentRecord,
    Bullpen008JointLossScenarioRecord,
    Bullpen008LossPreventionAuditRecord,
    Bullpen008PnlAttributionRecord,
    Bullpen008RegimeChangeEpisodeRecord,
    Bullpen008RunRecord,
    Bullpen008ScenarioCooldownRecord,
    Bullpen008SettingsRecord,
    Bullpen008StageOutputRecord,
    Bullpen008StateRecord,
)
from app.domains.bullpen008.schemas import (
    Bullpen008Bootstrap,
    Bullpen008Alert,
    Bullpen008EventTrend,
    Bullpen008EventTrendsResponse,
    Bullpen008HistoryPage,
    Bullpen008InheritedRun,
    Bullpen008Run,
    Bullpen008Settings,
    Bullpen008SettingsUpdate,
    Bullpen008StageOutput,
    Bullpen008State,
)
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveRunRecord,
    PolymarketAutoLiveSettingsRecord,
)
from app.domains.polymarket_auto_live.console_profile import (
    next_custom_console_schedule_time,
)
from app.domains.bullpen_run_audit.provenance import resolve_backend_commit_sha


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _hash(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _compact_run_options():
    """Load run-card facts without hydrating the large immutable JSON payloads."""
    return (
        selectinload(Bullpen008RunRecord.stages).load_only(
            Bullpen008StageOutputRecord.stage_number,
            Bullpen008StageOutputRecord.stage_name,
            Bullpen008StageOutputRecord.stage_version,
            Bullpen008StageOutputRecord.status,
            Bullpen008StageOutputRecord.pass_condition,
            Bullpen008StageOutputRecord.block_reason,
            Bullpen008StageOutputRecord.previous_stage_output_hash,
            Bullpen008StageOutputRecord.output_hash,
            Bullpen008StageOutputRecord.settings_snapshot_hash,
            Bullpen008StageOutputRecord.wallet_snapshot_hash,
            Bullpen008StageOutputRecord.prompt_version,
            Bullpen008StageOutputRecord.parser_version,
            Bullpen008StageOutputRecord.started_at,
            Bullpen008StageOutputRecord.completed_at,
            Bullpen008StageOutputRecord.duration_seconds,
        ),
        noload(Bullpen008RunRecord.certificate),
        noload(Bullpen008RunRecord.action_plan),
        noload(Bullpen008RunRecord.execution_intents),
    )


async def _attach_compact_stage_metrics(
    session: AsyncSession,
    records: list[Bullpen008RunRecord],
) -> None:
    """Attach only the two small JSON subobjects used by run-summary cards."""
    stages = [stage for record in records for stage in record.stages]
    stage_ids = [stage.id for stage in stages]
    if not stage_ids:
        return
    rows = (
        await session.execute(
            select(
                Bullpen008StageOutputRecord.id,
                Bullpen008StageOutputRecord.outputs_json["metrics"].label("metrics"),
                Bullpen008StageOutputRecord.outputs_json["risk_metrics"].label(
                    "risk_metrics"
                ),
            ).where(Bullpen008StageOutputRecord.id.in_(stage_ids))
        )
    ).all()
    compact_by_id = {
        row.id: {
            "metrics": row.metrics if isinstance(row.metrics, dict) else {},
            "risk_metrics": (
                row.risk_metrics if isinstance(row.risk_metrics, dict) else {}
            ),
        }
        for row in rows
    }
    for stage in stages:
        stage._compact_outputs_json = compact_by_id.get(  # type: ignore[attr-defined]
            stage.id,
            {"metrics": {}, "risk_metrics": {}},
        )


def _is_interrupted_previous_build(
    run_build: str | None,
    current_build: str | None,
) -> bool:
    return bool(
        run_build
        and current_build
        and run_build.strip()
        and current_build.strip()
        and run_build.strip() != current_build.strip()
    )


def _is_recoverable_interrupted_run(
    *,
    run_build: str | None,
    current_build: str | None,
    started_at: datetime,
    now: datetime,
) -> bool:
    if _is_interrupted_previous_build(run_build, current_build):
        return True
    return bool(
        not run_build
        and (now - started_at).total_seconds() >= RUN_LOCK_TTL_SECONDS
    )


async def recover_interrupted_previous_build_run(
    session: AsyncSession,
    *,
    user_id: int,
    current_build: str | None,
) -> str | None:
    """Fail only an unfinished 008 run that belonged to a replaced build.

    A production container replacement cannot leave the prior build's Celery
    process alive, but its Redis TTL may outlive that process.  Preserve any
    immutable stage facts already written, append explicit failed/blocked facts
    for missing stages, and never inspect or mutate a 007 record or key.
    """

    record = (
        await session.execute(
            select(Bullpen008RunRecord)
            .options(*_compact_run_options())
            .where(
                Bullpen008RunRecord.user_id == user_id,
                Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
                Bullpen008RunRecord.status.in_(("queued", "running")),
            )
            .order_by(Bullpen008RunRecord.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    completed_at = datetime.now(UTC)
    if record is None or not _is_recoverable_interrupted_run(
        run_build=record.code_build_version,
        current_build=current_build,
        started_at=record.started_at,
        now=completed_at,
    ):
        return None

    settings_hash = _hash(record.settings_snapshot)
    wallet_hash = _hash(record.wallet_snapshot)
    existing_by_number = {stage.stage_number: stage for stage in record.stages}
    previous_hash: str | None = None
    stage_names = {
        1: "Discover & Hard Filters",
        2: "Probability & Structural Risk",
        3: "Cluster & Dependency Map",
        4: "Portfolio Optimizer & Stress Test",
        5: "Exit & Rebalance Plan",
        6: "Execute & Reconcile",
    }
    first_missing = next(
        (number for number in range(1, 7) if number not in existing_by_number),
        None,
    )
    for stage_number in range(1, 7):
        existing = existing_by_number.get(stage_number)
        if existing is not None:
            previous_hash = existing.output_hash
            continue
        status = "failed" if stage_number == first_missing else "blocked"
        reason = (
            "The worker was interrupted by a production build replacement before "
            "this stage could satisfy its pass condition."
            if status == "failed"
            else "A previous stage was interrupted by a production build replacement."
        )
        outputs = {
            "metrics": {},
            "interrupted": True,
            "orders_created": 0,
            "orders_submitted": 0,
        }
        output_hash = _hash(
            {
                "run_id": record.id,
                "stage_number": stage_number,
                "status": status,
                "reason": reason,
                "previous_stage_output_hash": previous_hash,
                "current_build": current_build,
            }
        )
        session.add(
            Bullpen008StageOutputRecord(
                run_id=record.id,
                workflow_profile=WORKFLOW_PROFILE,
                stage_number=stage_number,
                stage_name=stage_names[stage_number],
                stage_version=STAGE_VERSIONS[stage_number],
                status=status,
                pass_condition="The defined stage pass condition must be satisfied.",
                block_reason=reason,
                previous_stage_output_hash=previous_hash,
                output_hash=output_hash,
                settings_snapshot_hash=settings_hash,
                wallet_snapshot_hash=wallet_hash,
                inputs_json={
                    "interrupted_build": record.code_build_version,
                    "replacement_build": current_build,
                },
                calculations_json={},
                outputs_json=outputs,
                rejections_json=[],
                warnings_json=[reason],
                provenance_json={
                    "workflow_profile": WORKFLOW_PROFILE,
                    "recovery": "build-aware-worker-interruption",
                    "orders_permitted": False,
                },
                prompt_version=None,
                parser_version=None,
                started_at=record.started_at,
                completed_at=completed_at,
                duration_seconds=max(
                    0.0,
                    (completed_at - record.started_at).total_seconds(),
                ),
            )
        )
        previous_hash = output_hash

    record.status = "failed"
    record.completed_at = completed_at
    record.summary = (
        "Bullpen 008 shadow run was interrupted by a production build replacement; "
        "no orders were created."
    )
    record.error_message = "worker_interrupted_by_build_replacement"
    record.run_metadata = {
        **dict(record.run_metadata),
        "recovered_interrupted_build": True,
        "replacement_build": current_build,
        "orders_created": 0,
        "orders_submitted": 0,
        "stage5_status": "failed" if first_missing == 5 else "blocked",
        "stage6_status": "failed" if first_missing == 6 else "blocked",
    }
    await session.commit()
    return record.id


def _seed_payload_from_007(payload: dict[str, object]) -> Bullpen008Settings:
    updates: dict[str, object] = {}
    field_map = {
        "console_min_market_odds": "binary_side_odds_floor_pct",
        "console_custom_exclude_phrases": "custom_exclude_phrases",
        "returns_per_day_formula": "returns_per_day_formula",
        "console_llm_targets": "llm_targets",
        "console_auto_start_at": "auto_start_at",
        "console_auto_refresh_minutes": "auto_refresh_minutes",
    }
    for source, target in field_map.items():
        if payload.get(source) is not None:
            updates[target] = payload[source]
    # Phase 1 safety and portfolio rules are authoritative and cannot be copied
    # from the live 007 profile.
    updates.update(
        {
            "workflow_profile": WORKFLOW_PROFILE,
            "shadow_mode": True,
            "execution_enabled": False,
            "bankroll_usd": 200,
            "max_contract_exposure_usd": 20,
            "max_strict_cluster_exposure_usd": 20,
            "max_common_catalyst_exposure_usd": 20,
            "allocation_increment_usd": 5,
            "entry_side_odds_floor_pct": 80,
            "min_llm_probability_pct": 80,
        }
    )
    return Bullpen008Settings.model_validate(updates)


async def ensure_seeded(
    session: AsyncSession,
    *,
    user_id: int,
) -> tuple[Bullpen008SettingsRecord, Bullpen008StateRecord]:
    settings_record = (
        await session.execute(
            select(Bullpen008SettingsRecord).where(
                Bullpen008SettingsRecord.user_id == user_id,
                Bullpen008SettingsRecord.workflow_profile == WORKFLOW_PROFILE,
            )
        )
    ).scalar_one_or_none()
    if settings_record is None:
        source_record = await session.get(PolymarketAutoLiveSettingsRecord, user_id)
        source_payload = (
            dict(source_record.payload) if source_record is not None else {}
        )
        seeded = _seed_payload_from_007(source_payload)
        settings_record = Bullpen008SettingsRecord(
            user_id=user_id,
            workflow_profile=WORKFLOW_PROFILE,
            seeded_from_profile="bullpen_console_top10",
            seeded_at=datetime.now(UTC),
            seed_source_hash=_hash(source_payload),
            payload=seeded.model_dump(mode="json"),
        )
        session.add(settings_record)
        await session.flush()

    state_record = (
        await session.execute(
            select(Bullpen008StateRecord).where(
                Bullpen008StateRecord.user_id == user_id,
                Bullpen008StateRecord.workflow_profile == WORKFLOW_PROFILE,
            )
        )
    ).scalar_one_or_none()
    if state_record is None:
        state_record = Bullpen008StateRecord(
            user_id=user_id,
            workflow_profile=WORKFLOW_PROFILE,
            running=False,
            paused=False,
            status="shadow-ready",
            payload={
                "shadow_mode": True,
                "execution_enabled": False,
                "execution_mode": "shadow",
                "live_control_armed": False,
                "emergency_stop": False,
                "seeded_scheduler_values": {
                    "auto_start_at": settings_record.payload.get("auto_start_at"),
                    "auto_refresh_minutes": settings_record.payload.get(
                        "auto_refresh_minutes"
                    ),
                },
            },
        )
        session.add(state_record)
        await session.flush()
    return settings_record, state_record


def settings_from_record(record: Bullpen008SettingsRecord) -> Bullpen008Settings:
    return Bullpen008Settings.model_validate(record.payload)


def state_from_record(record: Bullpen008StateRecord) -> Bullpen008State:
    return Bullpen008State(
        shadow_mode=bool(record.payload.get("shadow_mode", True)),
        execution_enabled=bool(record.payload.get("execution_enabled", False)),
        execution_mode=str(record.payload.get("execution_mode", "shadow")),
        running=record.running,
        paused=record.paused,
        emergency_stop=bool(record.payload.get("emergency_stop", False)),
        status=record.status,
        next_run_at=_iso(record.next_run_at),
        last_run_at=_iso(record.last_run_at),
        last_run_id=record.last_run_id,
        celery_task_name=CELERY_TASK_NAME,
        celery_queue=CELERY_QUEUE,
        redis_namespace=REDIS_PREFIX,
    )


def stage_from_record(
    record, *, include_payload: bool = True
) -> Bullpen008StageOutput:
    if include_payload:
        outputs = record.outputs_json
    else:
        source = record.__dict__.get(
            "_compact_outputs_json",
            record.__dict__.get("outputs_json", {}),
        )
        outputs = {
            "metrics": source.get("metrics", {}),
            "risk_metrics": source.get("risk_metrics", {}),
        }
    return Bullpen008StageOutput(
        stage_number=record.stage_number,
        stage_name=record.stage_name,
        stage_version=record.stage_version,
        status=record.status,
        pass_condition=record.pass_condition,
        block_reason=record.block_reason,
        previous_stage_output_hash=record.previous_stage_output_hash,
        output_hash=record.output_hash,
        settings_snapshot_hash=record.settings_snapshot_hash,
        wallet_snapshot_hash=record.wallet_snapshot_hash,
        inputs=record.inputs_json if include_payload else {},
        calculations=record.calculations_json if include_payload else {},
        outputs=outputs,
        rejections=record.rejections_json if include_payload else [],
        warnings=record.warnings_json if include_payload else [],
        provenance=record.provenance_json if include_payload else {},
        prompt_version=record.prompt_version,
        parser_version=record.parser_version,
        started_at=record.started_at.isoformat(),
        completed_at=record.completed_at.isoformat(),
        duration_seconds=record.duration_seconds,
    )


def run_from_record(
    record: Bullpen008RunRecord, *, include_stage_payloads: bool = True
) -> Bullpen008Run:
    certificate = (
        record.certificate.payload
        if include_stage_payloads and record.certificate is not None
        else None
    )
    action_plan = (
        record.action_plan.payload
        if include_stage_payloads and record.action_plan is not None
        else None
    )
    execution_intents = [
        {
            "intent_id": intent.id,
            "action_id": intent.action_id,
            "action_type": intent.action_type,
            "market_id": intent.market_id,
            "side": intent.side,
            "status": intent.status,
            "attempt_count": intent.attempt_count,
            "remote_order_id": intent.remote_order_id,
            "remote_transaction_id": intent.remote_transaction_id,
            "filled_shares": intent.filled_shares,
            "filled_value_usd": intent.filled_value_usd,
            "average_price_cents": intent.average_price_cents,
            "fees_usd": intent.fees_usd,
            "blocker_code": intent.blocker_code,
            "failure_message": intent.failure_message,
            "retryable": intent.retryable,
            "payload": intent.payload if include_stage_payloads else {},
        }
        for intent in (record.execution_intents if include_stage_payloads else [])
    ]
    return Bullpen008Run(
        id=record.id,
        status=record.status,
        triggered_by=record.triggered_by,
        shadow_mode=record.shadow_mode,
        execution_enabled=record.execution_enabled,
        started_at=record.started_at.isoformat(),
        completed_at=_iso(record.completed_at),
        summary=record.summary,
        error_message=record.error_message,
        code_build_version=record.code_build_version,
        settings_snapshot=record.settings_snapshot,
        wallet_snapshot=record.wallet_snapshot,
        task_metadata=record.task_metadata,
        run_metadata=record.run_metadata,
        stages=[
            stage_from_record(stage, include_payload=include_stage_payloads)
            for stage in record.stages
        ],
        portfolio_certificate=certificate,
        action_plan=action_plan,
        execution_intents=execution_intents,
    )


async def get_settings(session: AsyncSession, *, user_id: int) -> Bullpen008Settings:
    record, _ = await ensure_seeded(session, user_id=user_id)
    await session.commit()
    return settings_from_record(record)


async def update_settings(
    session: AsyncSession,
    *,
    user_id: int,
    update: Bullpen008SettingsUpdate,
) -> Bullpen008Settings:
    record, state = await ensure_seeded(session, user_id=user_id)
    current = settings_from_record(record)
    merged = current.model_dump(mode="json")
    merged.update(update.model_dump(exclude_unset=True, mode="json"))
    merged.update(
        {
            "workflow_profile": WORKFLOW_PROFILE,
            "shadow_mode": current.shadow_mode,
            "execution_enabled": current.execution_enabled,
            "execution_mode": current.execution_mode,
            "live_control_armed": current.live_control_armed,
        }
    )
    validated = Bullpen008Settings.model_validate(merged)
    record.payload = validated.model_dump(mode="json")
    state.payload = {
        **dict(state.payload),
        "shadow_mode": validated.shadow_mode,
        "execution_enabled": validated.execution_enabled,
        "execution_mode": validated.execution_mode,
        "live_control_armed": validated.live_control_armed,
        "saved_schedule": {
            "auto_start_at": validated.auto_start_at,
            "auto_refresh_minutes": validated.auto_refresh_minutes,
        },
    }
    await session.commit()
    return validated


def _next_run_at(settings: Bullpen008Settings, *, now: datetime) -> datetime:
    return next_custom_console_schedule_time(
        now,
        start_at=settings.auto_start_at,
        refresh_minutes=settings.auto_refresh_minutes,
    )


async def set_scheduler_running(
    session: AsyncSession,
    *,
    user_id: int,
    running: bool,
) -> Bullpen008State:
    settings_record, state = await ensure_seeded(session, user_id=user_id)
    settings = settings_from_record(settings_record)
    now = datetime.now(UTC)
    state.running = running
    state.paused = False
    state.status = "shadow-scheduled" if running else "shadow-stopped"
    state.next_run_at = _next_run_at(settings, now=now) if running else None
    state.payload = {
        **dict(state.payload),
        "last_action": "Bullpen 008 shadow scheduler started."
        if running
        else "Bullpen 008 shadow scheduler stopped.",
        "last_action_at": now.isoformat(),
    }
    await session.commit()
    return state_from_record(state)


async def set_scheduler_paused(
    session: AsyncSession,
    *,
    user_id: int,
    paused: bool,
) -> Bullpen008State:
    _, state = await ensure_seeded(session, user_id=user_id)
    now = datetime.now(UTC)
    state.paused = paused
    state.status = "shadow-paused" if paused else ("shadow-scheduled" if state.running else "shadow-ready")
    state.payload = {
        **dict(state.payload),
        "last_action": "Bullpen 008 scheduler paused." if paused else "Bullpen 008 scheduler resumed.",
        "last_action_at": now.isoformat(),
    }
    await session.commit()
    return state_from_record(state)


async def set_emergency_stop(
    session: AsyncSession,
    *,
    user_id: int,
    active: bool,
) -> Bullpen008State:
    _, state = await ensure_seeded(session, user_id=user_id)
    now = datetime.now(UTC)
    state.paused = True if active else state.paused
    state.status = "emergency-stopped" if active else ("shadow-paused" if state.paused else "shadow-ready")
    state.payload = {
        **dict(state.payload),
        "emergency_stop": active,
        "last_action": "Bullpen 008 emergency stop activated." if active else "Bullpen 008 emergency stop cleared.",
        "last_action_at": now.isoformat(),
    }
    await session.commit()
    return state_from_record(state)


async def set_execution_control(
    session: AsyncSession,
    *,
    user_id: int,
    live: bool,
) -> Bullpen008Settings:
    settings_record, state = await ensure_seeded(session, user_id=user_id)
    current = settings_from_record(settings_record)
    updated = Bullpen008Settings.model_validate(
        {
            **current.model_dump(mode="json"),
            "shadow_mode": not live,
            "execution_enabled": live,
            "execution_mode": "live" if live else "shadow",
            "live_control_armed": live,
        }
    )
    settings_record.payload = updated.model_dump(mode="json")
    state.payload = {
        **dict(state.payload),
        "shadow_mode": not live,
        "execution_enabled": live,
        "execution_mode": "live" if live else "shadow",
        "live_control_armed": live,
        "execution_control_changed_at": datetime.now(UTC).isoformat(),
    }
    await session.commit()
    return updated


async def create_run_record(
    session: AsyncSession,
    *,
    user_id: int,
    triggered_by: str,
    idempotency_key: str | None,
) -> Bullpen008RunRecord:
    settings_record, _ = await ensure_seeded(session, user_id=user_id)
    execution_settings = settings_from_record(settings_record)
    key = idempotency_key or f"bullpen008:{triggered_by}:{uuid4()}"
    existing = (
        await session.execute(
            select(Bullpen008RunRecord)
            .options(*_compact_run_options())
            .where(
                Bullpen008RunRecord.user_id == user_id,
                Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
                Bullpen008RunRecord.idempotency_key == key,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    run_id = f"b008-{uuid4().hex}"
    record = Bullpen008RunRecord(
        id=run_id,
        user_id=user_id,
        workflow_profile=WORKFLOW_PROFILE,
        idempotency_key=key,
        status="queued",
        triggered_by=triggered_by,
        shadow_mode=execution_settings.shadow_mode,
        execution_enabled=execution_settings.execution_enabled,
        started_at=datetime.now(UTC),
        summary="Bullpen 008 shadow-mode run queued for the six-stage pipeline.",
        code_build_version=resolve_backend_commit_sha(),
        settings_snapshot=dict(settings_record.payload),
        wallet_snapshot={},
        task_metadata={
            "task_name": CELERY_TASK_NAME,
            "queue": CELERY_QUEUE,
            "workflow_profile": WORKFLOW_PROFILE,
            "orders_permitted": False,
        },
        run_metadata={
            "phase": 2,
            "stages_enabled": [1, 2, 3, 4, 5, 6],
            "stages_disabled": [],
        },
    )
    session.add(record)
    await session.flush()
    await session.commit()
    return record


async def get_run(
    session: AsyncSession,
    *,
    user_id: int,
    run_id: str,
) -> Bullpen008RunRecord | None:
    return (
        await session.execute(
            select(Bullpen008RunRecord)
            .options(
                selectinload(Bullpen008RunRecord.stages),
                selectinload(Bullpen008RunRecord.certificate),
                selectinload(Bullpen008RunRecord.action_plan),
                selectinload(Bullpen008RunRecord.execution_intents),
            )
            .where(
                Bullpen008RunRecord.id == run_id,
                Bullpen008RunRecord.user_id == user_id,
                Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
            )
        )
    ).scalar_one_or_none()


async def get_stage(
    session: AsyncSession,
    *,
    user_id: int,
    run_id: str,
    stage_number: int,
) -> Bullpen008StageOutput | None:
    record = (
        await session.execute(
            select(Bullpen008StageOutputRecord)
            .join(
                Bullpen008RunRecord,
                Bullpen008RunRecord.id == Bullpen008StageOutputRecord.run_id,
            )
            .where(
                Bullpen008StageOutputRecord.run_id == run_id,
                Bullpen008StageOutputRecord.stage_number == stage_number,
                Bullpen008StageOutputRecord.workflow_profile == WORKFLOW_PROFILE,
                Bullpen008RunRecord.user_id == user_id,
                Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
            )
        )
    ).scalar_one_or_none()
    return stage_from_record(record) if record is not None else None


async def _inherited_runs(
    session: AsyncSession,
    *,
    user_id: int,
    limit: int = 10,
) -> list[Bullpen008InheritedRun]:
    records = (
        (
            await session.execute(
                select(PolymarketAutoLiveRunRecord)
                .where(PolymarketAutoLiveRunRecord.user_id == user_id)
                .order_by(PolymarketAutoLiveRunRecord.started_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return [
        Bullpen008InheritedRun(
            id=record.id,
            status=record.status,
            started_at=record.started_at.isoformat(),
            completed_at=_iso(record.completed_at),
            summary=record.summary,
        )
        for record in records
    ]


async def get_bootstrap(
    session: AsyncSession,
    *,
    user_id: int,
) -> Bullpen008Bootstrap:
    settings_record, state_record = await ensure_seeded(session, user_id=user_id)
    latest = (
        await session.execute(
            select(Bullpen008RunRecord)
            .options(*_compact_run_options())
            .where(
                Bullpen008RunRecord.user_id == user_id,
                Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
            )
            .order_by(Bullpen008RunRecord.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if latest is not None:
        await _attach_compact_stage_metrics(session, [latest])
    inherited = await _inherited_runs(session, user_id=user_id)
    alert_records = (
        (
            await session.execute(
                select(Bullpen008AlertRecord)
                .where(
                    Bullpen008AlertRecord.user_id == user_id,
                    Bullpen008AlertRecord.workflow_profile == WORKFLOW_PROFILE,
                )
                .order_by(Bullpen008AlertRecord.created_at.desc())
                .limit(20)
            )
        )
        .scalars()
        .all()
    )
    latest_run_id = latest.id if latest is not None else None
    scenario_records = [] if latest_run_id is None else (
        (
            await session.execute(
                select(Bullpen008JointLossScenarioRecord)
                .where(Bullpen008JointLossScenarioRecord.run_id == latest_run_id)
                .order_by(Bullpen008JointLossScenarioRecord.id.asc())
            )
        ).scalars().all()
    )
    activation_records = (
        (
            await session.execute(
                select(Bullpen008ContingentExitActivationRecord)
                .where(Bullpen008ContingentExitActivationRecord.user_id == user_id)
                .order_by(Bullpen008ContingentExitActivationRecord.activated_at.desc())
                .limit(20)
            )
        ).scalars().all()
    )
    regime_records = (
        (
            await session.execute(
                select(Bullpen008RegimeChangeEpisodeRecord)
                .where(Bullpen008RegimeChangeEpisodeRecord.user_id == user_id)
                .order_by(Bullpen008RegimeChangeEpisodeRecord.activated_at.desc())
                .limit(20)
            )
        ).scalars().all()
    )
    drawdown_record = (
        await session.execute(
            select(Bullpen008DrawdownEpisodeRecord)
            .where(Bullpen008DrawdownEpisodeRecord.user_id == user_id)
            .order_by(Bullpen008DrawdownEpisodeRecord.activated_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    cooldown_records = (
        (
            await session.execute(
                select(Bullpen008ScenarioCooldownRecord)
                .where(Bullpen008ScenarioCooldownRecord.user_id == user_id)
                .order_by(Bullpen008ScenarioCooldownRecord.starts_at.desc())
                .limit(20)
            )
        ).scalars().all()
    )
    pnl_records = [] if latest_run_id is None else (
        (
            await session.execute(
                select(Bullpen008PnlAttributionRecord)
                .where(Bullpen008PnlAttributionRecord.run_id == latest_run_id)
                .order_by(Bullpen008PnlAttributionRecord.market_id.asc())
            )
        ).scalars().all()
    )
    audit_records = [] if latest_run_id is None else (
        (
            await session.execute(
                select(Bullpen008LossPreventionAuditRecord)
                .where(Bullpen008LossPreventionAuditRecord.run_id == latest_run_id)
                .order_by(Bullpen008LossPreventionAuditRecord.market_id.asc())
            )
        ).scalars().all()
    )
    await session.commit()
    return Bullpen008Bootstrap(
        settings=settings_from_record(settings_record),
        state=state_from_record(state_record),
        latest_run=run_from_record(latest, include_stage_payloads=False)
        if latest is not None
        else None,
        inherited_runs=inherited,
        alerts=[
            Bullpen008Alert(
                id=record.id,
                market_id=record.market_id,
                side=record.side,
                source=record.source,
                breach_type=record.breach_type,
                llm_odds=record.llm_odds,
                actual_odds=record.actual_odds,
                created_at=record.created_at.isoformat(),
                recovered_at=_iso(record.recovered_at),
                payload=record.payload,
            )
            for record in alert_records
        ],
        risk_state={
            "joint_loss_scenarios": [record.payload for record in scenario_records],
            "contingent_activations": [record.payload for record in activation_records],
            "regime_change_episodes": [
                {
                    **record.payload,
                    "scenario_id": record.scenario_id,
                    "status": record.status,
                    "activated_at": _iso(record.activated_at),
                    "recovered_at": _iso(record.recovered_at),
                }
                for record in regime_records
            ],
            "drawdown": drawdown_record.payload if drawdown_record is not None else {
                "state": "NOT_YET_BASELINED",
                "soft_threshold_usd": round(settings_from_record(settings_record).bankroll_usd * settings_from_record(settings_record).soft_drawdown_pct / 100, 2),
                "hard_threshold_usd": round(settings_from_record(settings_record).bankroll_usd * settings_from_record(settings_record).hard_drawdown_pct / 100, 2),
            },
            "scenario_cooldowns": [
                {**record.payload, "scenario_id": record.scenario_id, "status": record.status, "starts_at": _iso(record.starts_at), "ends_at": _iso(record.ends_at)}
                for record in cooldown_records
            ],
            "pnl_attribution": [record.payload for record in pnl_records],
            "loss_prevention_audit": [record.payload for record in audit_records],
        },
    )


async def get_history(
    session: AsyncSession,
    *,
    user_id: int,
    limit: int,
    offset: int,
) -> Bullpen008HistoryPage:
    records = (
        (
            await session.execute(
                select(Bullpen008RunRecord)
                .options(*_compact_run_options())
                .where(
                    Bullpen008RunRecord.user_id == user_id,
                    Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
                )
                .order_by(Bullpen008RunRecord.started_at.desc())
                .offset(offset)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    await _attach_compact_stage_metrics(session, list(records))
    total = int(
        (
            await session.execute(
                select(func.count(Bullpen008RunRecord.id)).where(
                    Bullpen008RunRecord.user_id == user_id,
                    Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
                )
            )
        ).scalar_one()
    )
    inherited = (
        await _inherited_runs(session, user_id=user_id, limit=10) if offset == 0 else []
    )
    return Bullpen008HistoryPage(
        rows=[
            run_from_record(record, include_stage_payloads=False)
            for record in records
        ],
        inherited_rows=inherited,
        total=total,
        limit=limit,
        offset=offset,
    )


async def cancel_active_run(
    session: AsyncSession,
    *,
    user_id: int,
) -> Bullpen008RunRecord | None:
    """Terminalize the newest 008 run without touching any Bullpen 007 state."""
    record = (
        (
            await session.execute(
                select(Bullpen008RunRecord)
                .options(*_compact_run_options())
                .where(
                    Bullpen008RunRecord.user_id == user_id,
                    Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
                    Bullpen008RunRecord.status.in_(("queued", "running")),
                )
                .order_by(Bullpen008RunRecord.started_at.desc())
                .limit(1)
            )
        )
        .scalars()
        .first()
    )
    if record is None:
        return None

    now = datetime.now(UTC)
    record.status = "cancelled"
    record.completed_at = now
    record.summary = "Bullpen 008 shadow run was killed by the user."
    record.error_message = "cancelled_by_user"
    record.run_metadata = {
        **dict(record.run_metadata),
        "cancelled_by_user": True,
        "cancelled_at": now.isoformat(),
        "orders_permitted": False,
    }
    record.task_metadata = {
        **dict(record.task_metadata),
        "revocation_requested_at": now.isoformat(),
    }
    state = (
        await session.execute(
            select(Bullpen008StateRecord).where(
                Bullpen008StateRecord.user_id == user_id,
                Bullpen008StateRecord.workflow_profile == WORKFLOW_PROFILE,
            )
        )
    ).scalar_one_or_none()
    if state is not None:
        state.last_run_at = now
        state.last_run_id = record.id
        state.status = "shadow-paused" if state.paused else (
            "shadow-scheduled" if state.running else "shadow-ready"
        )
        state.payload = {
            **dict(state.payload),
            "last_action": f"Bullpen 008 run {record.id} killed by the user.",
            "last_action_at": now.isoformat(),
        }
    await session.commit()
    return record


def _trend_number(*values: object) -> float | None:
    for value in values:
        if isinstance(value, bool) or value is None:
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number == number:
            return number
    return None


def _trend_text(*values: object) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


async def get_event_trends(
    session: AsyncSession,
    *,
    user_id: int,
    scan_count: int = 20,
) -> Bullpen008EventTrendsResponse:
    """Build the Bullpen 007-style 20-scan widget from isolated 008 Stage 2 facts."""
    normalized_scan_count = max(1, min(scan_count, 20))
    run_rows = (
        await session.execute(
            select(Bullpen008RunRecord.id, Bullpen008RunRecord.started_at)
            .where(
                Bullpen008RunRecord.user_id == user_id,
                Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
            )
            .order_by(Bullpen008RunRecord.started_at.desc())
            .limit(normalized_scan_count)
        )
    ).all()
    run_ids = [row.id for row in run_rows]
    stage_rows = [] if not run_ids else (
        await session.execute(
            select(
                Bullpen008StageOutputRecord.run_id,
                Bullpen008StageOutputRecord.inputs_json,
                Bullpen008StageOutputRecord.outputs_json,
                Bullpen008StageOutputRecord.completed_at,
            ).where(
                Bullpen008StageOutputRecord.run_id.in_(run_ids),
                Bullpen008StageOutputRecord.workflow_profile == WORKFLOW_PROFILE,
                Bullpen008StageOutputRecord.stage_number == 2,
            )
        )
    ).all()
    stage_by_run = {row.run_id: row for row in stage_rows}
    event_rows: dict[str, dict[str, object]] = {}

    for scan_index, run_row in enumerate(run_rows):
        stage = stage_by_run.get(run_row.id)
        if stage is None:
            continue
        rows = stage.outputs_json.get("rows", [])
        if not isinstance(rows, list):
            continue
        provider = _trend_text(stage.inputs_json.get("provider")) or "Bullpen 008"
        model = _trend_text(stage.inputs_json.get("model")) or "probability-risk"
        timestamp = stage.completed_at.isoformat()
        for raw_row in rows:
            if not isinstance(raw_row, dict):
                continue
            market_id = _trend_text(raw_row.get("market_id"))
            title = _trend_text(raw_row.get("question"), raw_row.get("market_title"))
            yes_probability = _trend_number(
                raw_row.get("llm_yes_probability"),
                raw_row.get("llm_yes_odds"),
            )
            no_probability = _trend_number(
                raw_row.get("llm_no_probability"),
                raw_row.get("llm_no_odds"),
            )
            if not market_id or not title or yes_probability is None or no_probability is None:
                continue
            strongest = max(yes_probability, no_probability)
            side: Literal["YES", "NO"] = (
                "YES" if yes_probability >= no_probability else "NO"
            )
            entry = event_rows.setdefault(
                market_id,
                {
                    "title": title,
                    "scores": [None] * 20,
                    "sides": [None] * 20,
                    "timestamps": [None] * 20,
                    "llm_outputs": [[] for _ in range(20)],
                    "latest": {},
                },
            )
            entry["scores"][scan_index] = round(strongest, 2)
            entry["sides"][scan_index] = side
            entry["timestamps"][scan_index] = timestamp
            entry["llm_outputs"][scan_index] = [
                {
                    "provider": provider,
                    "model": model,
                    "status": "completed",
                    "llm_yes_odds": round(yes_probability, 2),
                    "llm_no_odds": round(no_probability, 2),
                    "direction": f"{side}_CAMP",
                    "confidence": raw_row.get("confidence"),
                    "evidence_status": raw_row.get("evidence_quality"),
                    "key_evidence": raw_row.get("key_evidence", []),
                    "red_flags": raw_row.get("red_flags", []),
                    "rationale": raw_row.get("rationale"),
                    "completed_at": timestamp,
                }
            ]
            if scan_index == 0:
                entry["latest"] = raw_row

    events: list[Bullpen008EventTrend] = []
    for market_id, entry in event_rows.items():
        latest = entry["latest"] if isinstance(entry.get("latest"), dict) else {}
        held_sides = latest.get("held_sides", [])
        active_side = (
            str(held_sides[0]).upper()
            if isinstance(held_sides, list) and held_sides
            else None
        )
        if active_side not in {"YES", "NO"}:
            active_side = None
        scores = entry["scores"]
        events.append(
            Bullpen008EventTrend(
                market_id=market_id,
                market_title=str(entry["title"]),
                market_url=_trend_text(
                    latest.get("market_url"),
                    latest.get("source_url"),
                ),
                close_time=_trend_text(
                    latest.get("deadline"),
                    latest.get("close_time"),
                ),
                score=round(
                    sum((scores[index] or 0) * weight for index, weight in enumerate((1, 0.5, 0.25))),
                    2,
                ),
                scan_scores=scores,
                scan_sides=entry["sides"],
                scan_timestamps=entry["timestamps"],
                scan_llm_outputs=entry["llm_outputs"],
                current_yes_odds=_trend_number(latest.get("current_yes_odds")),
                current_no_odds=_trend_number(latest.get("current_no_odds")),
                llm_yes_odds=_trend_number(
                    latest.get("llm_yes_probability"),
                    latest.get("llm_yes_odds"),
                ),
                llm_no_odds=_trend_number(
                    latest.get("llm_no_probability"),
                    latest.get("llm_no_odds"),
                ),
                returns_per_day=_trend_number(latest.get("returns_per_day")),
                is_active_position=active_side is not None,
                is_claimable_position=bool(latest.get("claimable")),
                active_position_side=active_side,
            )
        )
    events.sort(key=lambda event: (-event.score, event.market_title.casefold()))
    return Bullpen008EventTrendsResponse(
        events=events,
        scan_count=20,
        generated_at=datetime.now(UTC).isoformat(),
    )
