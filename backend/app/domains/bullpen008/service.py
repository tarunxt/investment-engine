from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.domains.bullpen008.constants import (
    CELERY_QUEUE,
    CELERY_TASK_NAME,
    REDIS_PREFIX,
    STAGE_VERSIONS,
    WORKFLOW_PROFILE,
)
from app.domains.bullpen008.models import (
    Bullpen008RunRecord,
    Bullpen008SettingsRecord,
    Bullpen008StageOutputRecord,
    Bullpen008StateRecord,
)
from app.domains.bullpen008.schemas import (
    Bullpen008Bootstrap,
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


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _hash(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


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
            .options(selectinload(Bullpen008RunRecord.stages))
            .where(
                Bullpen008RunRecord.user_id == user_id,
                Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
                Bullpen008RunRecord.status.in_(("queued", "running")),
            )
            .order_by(Bullpen008RunRecord.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if record is None or not _is_interrupted_previous_build(
        record.code_build_version,
        current_build,
    ):
        return None

    completed_at = datetime.now(UTC)
    settings_hash = _hash(record.settings_snapshot)
    wallet_hash = _hash(record.wallet_snapshot)
    existing_by_number = {stage.stage_number: stage for stage in record.stages}
    previous_hash: str | None = None
    stage_names = {
        1: "Discover & Hard Filters",
        2: "Probability & Structural Risk",
        3: "Cluster & Dependency Map",
        4: "Portfolio Optimizer & Stress Test",
    }
    first_missing = next(
        (number for number in range(1, 5) if number not in existing_by_number),
        None,
    )
    for stage_number in range(1, 5):
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
        "stage5_status": "disabled_pending_phase2",
        "stage6_status": "disabled_pending_phase2",
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
        running=record.running,
        paused=record.paused,
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
    outputs = (
        record.outputs_json
        if include_payload
        else {"metrics": record.outputs_json.get("metrics", {})}
    )
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
    certificate = record.certificate.payload if record.certificate is not None else None
    return Bullpen008Run(
        id=record.id,
        status=record.status,
        triggered_by=record.triggered_by,
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
            "shadow_mode": True,
            "execution_enabled": False,
        }
    )
    validated = Bullpen008Settings.model_validate(merged)
    record.payload = validated.model_dump(mode="json")
    state.payload = {
        **dict(state.payload),
        "shadow_mode": True,
        "execution_enabled": False,
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


async def create_run_record(
    session: AsyncSession,
    *,
    user_id: int,
    triggered_by: str,
    idempotency_key: str | None,
) -> Bullpen008RunRecord:
    settings_record, _ = await ensure_seeded(session, user_id=user_id)
    key = idempotency_key or f"bullpen008:{triggered_by}:{uuid4()}"
    existing = (
        await session.execute(
            select(Bullpen008RunRecord)
            .options(
                selectinload(Bullpen008RunRecord.stages),
                selectinload(Bullpen008RunRecord.certificate),
            )
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
        shadow_mode=True,
        execution_enabled=False,
        started_at=datetime.now(UTC),
        summary="Bullpen 008 shadow-mode run queued for Stages 1-4.",
        code_build_version=os.getenv("APP_COMMIT_SHA") or os.getenv("GIT_COMMIT_SHA"),
        settings_snapshot=dict(settings_record.payload),
        wallet_snapshot={},
        task_metadata={
            "task_name": CELERY_TASK_NAME,
            "queue": CELERY_QUEUE,
            "workflow_profile": WORKFLOW_PROFILE,
            "orders_permitted": False,
        },
        run_metadata={
            "phase": 1,
            "stages_enabled": [1, 2, 3, 4],
            "stages_disabled": [5, 6],
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
            .options(
                selectinload(Bullpen008RunRecord.stages),
                selectinload(Bullpen008RunRecord.certificate),
            )
            .where(
                Bullpen008RunRecord.user_id == user_id,
                Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
            )
            .order_by(Bullpen008RunRecord.started_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    inherited = await _inherited_runs(session, user_id=user_id)
    await session.commit()
    return Bullpen008Bootstrap(
        settings=settings_from_record(settings_record),
        state=state_from_record(state_record),
        latest_run=run_from_record(latest, include_stage_payloads=False)
        if latest is not None
        else None,
        inherited_runs=inherited,
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
                .options(
                    selectinload(Bullpen008RunRecord.stages),
                    selectinload(Bullpen008RunRecord.certificate),
                )
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
    total = len(
        (
            await session.execute(
                select(Bullpen008RunRecord.id).where(
                    Bullpen008RunRecord.user_id == user_id,
                    Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
                )
            )
        )
        .scalars()
        .all()
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
