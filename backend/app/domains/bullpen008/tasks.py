from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

import redis as sync_redis
from sqlalchemy import select
from sqlalchemy.orm import selectinload

import app.infrastructure.database.all_models  # noqa: F401
from app.core.config import settings as app_settings
from app.core.logging import get_logger
from app.domains.ai_providers.factory import ProviderFactory
from app.domains.bullpen008.constants import (
    CELERY_QUEUE,
    CELERY_SCHEDULER_TASK_NAME,
    CELERY_TASK_NAME,
    CLUSTER_PROMPT_VERSION,
    COMPLETE_UNIVERSE_SCAN_TIMEOUT_SECONDS,
    LLM_PROMPT_VERSION,
    PENDING_MARKER_TTL_SECONDS,
    PENDING_ORDER_STATUSES,
    REDIS_PREFIX,
    RUN_LOCK_TTL_SECONDS,
    STAGE_VERSIONS,
    WORKFLOW_PROFILE,
)
from app.domains.bullpen008.engine import (
    STAGE2_PARSER_VERSION,
    STAGE3_PARSER_VERSION,
    build_cluster_prompt,
    build_portfolio_target,
    build_probability_risk_prompt,
    build_stage1_output,
    canonical_json,
    normalize_cluster_rows,
    normalize_stage2_rows,
    parse_cluster_response,
    parse_probability_risk_response,
    stable_hash,
)
from app.domains.bullpen008.models import (
    Bullpen008PortfolioCertificateRecord,
    Bullpen008RunRecord,
    Bullpen008SettingsRecord,
    Bullpen008StageOutputRecord,
    Bullpen008StateRecord,
)
from app.domains.bullpen008.schemas import Bullpen008Settings
from app.domains.polymarket.bullpen import BullpenBalanceReader
from app.domains.polymarket_auto_live.console_profile import (
    next_custom_console_schedule_time,
    read_console_wallet_positions_snapshot,
    scan_console_profile_markets,
)
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveOrderIntentRecord,
)
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery

logger = get_logger("app.domains.bullpen008.tasks")


def _redis() -> sync_redis.Redis:
    return sync_redis.from_url(app_settings.redis_url, decode_responses=True)


def _run_lock_key(run_id: str) -> str:
    return f"{REDIS_PREFIX}:run:{run_id}:lock"


def _pending_key(user_id: int) -> str:
    return f"{REDIS_PREFIX}:pending:user:{user_id}"


def _first(raw: dict[str, Any], *keys: str) -> object:
    for key in keys:
        if raw.get(key) is not None:
            return raw[key]
    return None


def _nested_parent_event(raw: dict[str, Any]) -> tuple[str | None, str | None]:
    events = raw.get("events")
    if isinstance(events, list):
        for event in events:
            if isinstance(event, dict):
                return (
                    str(_first(event, "id", "eventId", "event_id") or "") or None,
                    str(_first(event, "slug", "eventSlug", "event_slug") or "") or None,
                )
    return (
        str(_first(raw, "eventId", "event_id") or "") or None,
        str(_first(raw, "eventSlug", "event_slug") or "") or None,
    )


def _market_packet(market: object, *, quote_timestamp: str) -> dict[str, object]:
    raw = dict(getattr(market, "raw", None) or {})
    parent_event_id, event_slug = _nested_parent_event(raw)
    outcomes = (
        getattr(market, "outcome_labels", None)
        or _first(raw, "outcomes", "outcomeLabels")
        or []
    )
    if isinstance(outcomes, str):
        outcomes = [
            part.strip()
            for part in outcomes.strip("[]").replace('"', "").split(",")
            if part.strip()
        ]
    tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
    return {
        "market_id": str(getattr(market, "market_id", "")),
        "condition_id": _first(raw, "conditionId", "condition_id"),
        "question_id": _first(raw, "questionId", "question_id"),
        "parent_event_id": parent_event_id,
        "event_slug": event_slug or getattr(market, "event_slug", None),
        "slug": getattr(market, "slug", None),
        "question": getattr(market, "question", None),
        "category": getattr(market, "theme", None),
        "tags": tags,
        "outcomes": outcomes,
        "resolution_rules": _first(raw, "rules", "resolutionRules", "description")
        or getattr(market, "description", None),
        "resolution_source": _first(
            raw, "resolutionSource", "resolution_source", "source"
        ),
        "deadline": getattr(market, "close_time", None),
        "timezone": _first(raw, "timezone", "resolutionTimezone") or "UTC",
        "open": raw.get("active", True) is not False and raw.get("closed") is not True,
        "closed": bool(raw.get("closed")),
        "resolved": bool(raw.get("resolved")),
        "claimable": bool(raw.get("claimable") or raw.get("redeemable")),
        "accepting_orders": raw.get(
            "acceptingOrders", raw.get("accepting_orders", True)
        ),
        "current_yes_odds": getattr(market, "current_yes_odds", None),
        "current_no_odds": getattr(market, "current_no_odds", None),
        "quote_timestamp": _first(raw, "updatedAt", "updated_at", "quoteTimestamp")
        or quote_timestamp,
        "liquidity": getattr(market, "liquidity_usd", None),
        "volume": getattr(market, "volume_usd", None),
        "spread": getattr(market, "spread_cents", None),
        "context": _first(raw, "context", "marketContext"),
        "source": "Polymarket Gamma API / Bullpen discover",
    }


def _position_packet(position: object, *, quote_timestamp: str) -> dict[str, object]:
    return {
        "market_id": str(getattr(position, "market_id", "")),
        "condition_id": getattr(position, "condition_id", None),
        "slug": getattr(position, "slug", None),
        "question": getattr(position, "market_title", None),
        "market_title": getattr(position, "market_title", None),
        "category": getattr(position, "theme", None),
        "theme": getattr(position, "theme", None),
        "outcomes": ["YES", "NO"],
        "deadline": getattr(position, "close_time", None),
        "close_time": getattr(position, "close_time", None),
        "timezone": "UTC",
        "open": getattr(position, "classification", "active") == "active",
        "closed": getattr(position, "classification", "active") == "closed",
        "resolved": getattr(position, "classification", "active") == "claimable",
        "claimable": bool(getattr(position, "is_claimable", False)),
        "accepting_orders": getattr(position, "classification", "active") == "active",
        "current_yes_odds": getattr(position, "current_yes_odds", None),
        "current_no_odds": getattr(position, "current_no_odds", None),
        "quote_timestamp": quote_timestamp,
        "side": getattr(position, "side", None),
        "shares": getattr(position, "shares", 0),
        "average_price_cents": getattr(position, "average_price_cents", 0),
        "exposure_usd": getattr(position, "exposure_usd", 0),
        "current_value_usd": getattr(position, "current_value_usd", None),
        "classification": getattr(position, "classification", "active"),
        "source": "shared Bullpen wallet snapshot",
    }


async def _capture_stage1_inputs(
    settings: Bullpen008Settings,
) -> tuple[
    list[dict[str, object]],
    list[dict[str, object]],
    dict[str, object],
    dict[str, object],
]:
    now = datetime.now(UTC)
    scan, wallet, balance = await asyncio.gather(
        scan_console_profile_markets(
            now=now,
            min_market_odds=0,
            custom_exclude_phrases=[],
            apply_base_filters=False,
            use_keyset_pagination=True,
            gamma_scan_timeout_seconds=COMPLETE_UNIVERSE_SCAN_TIMEOUT_SECONDS,
        ),
        read_console_wallet_positions_snapshot(
            force_fresh=True,
            caller_source="bullpen008-stage1-shadow",
            max_age_seconds=settings.stale_quote_seconds,
        ),
        BullpenBalanceReader().refresh(wait_for_login=False),
    )
    market_packets = [
        _market_packet(market, quote_timestamp=scan.scanned_at)
        for market in scan.accepted
    ]
    existing_ids = {str(row["market_id"]) for row in market_packets}
    for rejected in scan.rejected:
        market_id = str(rejected.market_id)
        if market_id in existing_ids:
            continue
        market_packets.append(
            {
                "market_id": market_id,
                "slug": rejected.slug,
                "question": rejected.question,
                "resolution_rules": None,
                "deadline": None,
                "current_yes_odds": None,
                "current_no_odds": None,
                "quote_timestamp": scan.scanned_at,
                "outcomes": [],
                "source": scan.source_label,
                "source_filter_reasons": list(rejected.reasons),
            }
        )
    active_positions = [
        _position_packet(position, quote_timestamp=wallet.fetched_at)
        for position in wallet.positions
        if getattr(position, "classification", "active")
        in {"active", "claimable", "settlement_pending"}
    ]
    wallet_snapshot = {
        "source": wallet.source,
        "fetched_at": wallet.fetched_at,
        "freshness_state": wallet.freshness_state,
        "account_identity": wallet.account_identity,
        "credential_artifact": wallet.credential_artifact,
        "raw_position_count": wallet.raw_position_count,
        "positions": active_positions,
        "balance": balance.model_dump(mode="json"),
        "freshness_proof": {
            "auth_checked_at": wallet.auth_checked_at,
            "cli_version": wallet.cli_version,
            "position_classifier_version": wallet.position_classifier_version,
        },
    }
    scan_metadata = {
        "source_label": scan.source_label,
        "source_url": scan.source_url,
        "scanned_at": scan.scanned_at,
        "total_candidates": scan.total_candidates,
        "complete_universe": scan.complete_universe,
        "warning": scan.warning,
        "details": scan.details,
        "pre_stage1_filters_applied": False,
        "pagination_mode": "gamma-markets-keyset",
        "scan_timeout_seconds": COMPLETE_UNIVERSE_SCAN_TIMEOUT_SECONDS,
    }
    return market_packets, active_positions, wallet_snapshot, scan_metadata


def _stage_record(
    *,
    run: Bullpen008RunRecord,
    stage_number: int,
    stage_name: str,
    started_at: datetime,
    status: str,
    pass_condition: str,
    inputs: dict[str, object],
    calculations: dict[str, object],
    outputs: dict[str, object],
    rejections: list[object],
    warnings: list[object],
    block_reason: str | None = None,
    prompt_version: str | None = None,
    parser_version: str | None = None,
) -> Bullpen008StageOutputRecord:
    completed_at = datetime.now(UTC)
    previous = next(
        (stage for stage in reversed(run.stages) if stage.stage_number < stage_number),
        None,
    )
    output_payload = {
        "inputs": inputs,
        "calculations": calculations,
        "outputs": outputs,
        "rejections": rejections,
        "warnings": warnings,
        "status": status,
        "stage_version": STAGE_VERSIONS[stage_number],
    }
    return Bullpen008StageOutputRecord(
        run_id=run.id,
        workflow_profile=WORKFLOW_PROFILE,
        stage_number=stage_number,
        stage_name=stage_name,
        stage_version=STAGE_VERSIONS[stage_number],
        status=status,
        pass_condition=pass_condition,
        block_reason=block_reason,
        previous_stage_output_hash=previous.output_hash
        if previous is not None
        else None,
        output_hash=stable_hash(output_payload),
        settings_snapshot_hash=stable_hash(run.settings_snapshot),
        wallet_snapshot_hash=stable_hash(run.wallet_snapshot),
        inputs_json=inputs,
        calculations_json=calculations,
        outputs_json=outputs,
        rejections_json=rejections,
        warnings_json=warnings,
        provenance_json={
            "workflow_profile": WORKFLOW_PROFILE,
            "run_id": run.id,
            "code_build_version": run.code_build_version,
            "shadow_mode": True,
            "orders_permitted": False,
            "market_quote_timestamps_retained": True,
            "wallet_snapshot_freshness_proof": run.wallet_snapshot.get(
                "freshness_proof", {}
            ),
        },
        prompt_version=prompt_version,
        parser_version=parser_version,
        started_at=started_at,
        completed_at=completed_at,
        duration_seconds=max(0, (completed_at - started_at).total_seconds()),
    )


def _provider_target(settings: Bullpen008Settings) -> tuple[str, str]:
    if not settings.llm_targets:
        raise ValueError("Bullpen 008 has no saved Stage 2 LLM target.")
    target = settings.llm_targets[0]
    health = ProviderFactory.validate_target(target.provider, target.model)
    if not health.available:
        raise ValueError(health.reason or "Saved LLM target is unavailable.")
    return target.provider, target.model


def _stage2_repair_market_ids(stage2: dict[str, object]) -> list[str]:
    market_ids = {
        str(value)
        for value in stage2.get("missing_market_ids", [])
        if value
    }
    for error in stage2.get("validation_errors", []):
        if isinstance(error, dict) and error.get("market_id"):
            market_ids.add(str(error["market_id"]))
    return sorted(market_ids)


def _stage2_input_rows(stage1_rows: list[dict[str, object]]) -> list[dict[str, object]]:
    return [
        row
        for row in stage1_rows
        if row.get("accounting_status") in {"accepted", "accepted_monitoring"}
    ]


def _merge_stage2_provider_rows(
    original: list[dict[str, object]],
    repair: list[dict[str, object]],
    *,
    repair_market_ids: list[str],
) -> list[dict[str, object]]:
    repair_ids = set(repair_market_ids)
    merged = [
        row
        for row in original
        if str(row.get("market_id") or "") not in repair_ids
    ]
    merged.extend(repair)
    return merged


def _provider_usage(response: object) -> dict[str, object]:
    return {
        "tokens_in": getattr(response, "tokens_in", 0) or 0,
        "tokens_out": getattr(response, "tokens_out", 0) or 0,
        "cost": getattr(response, "cost", 0) or 0,
        "provider": getattr(response, "provider", None),
        "model": getattr(response, "model", None),
    }


def _aggregate_provider_usage(
    attempts: list[dict[str, object]], *, provider: str, model: str
) -> dict[str, object]:
    totals = {"tokens_in": 0.0, "tokens_out": 0.0, "cost": 0.0}
    for attempt in attempts:
        usage = attempt.get("provider_usage")
        if not isinstance(usage, dict):
            continue
        for key in totals:
            value = usage.get(key)
            if isinstance(value, (int, float)):
                totals[key] += float(value)
    return {
        "tokens_in": int(totals["tokens_in"]),
        "tokens_out": int(totals["tokens_out"]),
        "cost": totals["cost"],
        "provider": provider,
        "model": model,
    }


def _pending_exposures(user_id: int) -> tuple[dict[str, float], dict[str, float]]:
    pending_buys: dict[str, float] = {}
    confirmed_exits: dict[str, float] = {}
    with SyncSessionLocal() as session:
        records = (
            session.execute(
                select(PolymarketAutoLiveOrderIntentRecord).where(
                    PolymarketAutoLiveOrderIntentRecord.user_id == user_id
                )
            )
            .scalars()
            .all()
        )
    for intent in records:
        market_id = str(intent.market_id)
        action = str(intent.action).upper()
        status = str(intent.status).lower()
        if action == "BUY" and status in PENDING_ORDER_STATUSES:
            pending_buys[market_id] = pending_buys.get(market_id, 0) + float(
                intent.current_order_usd
                or intent.requested_order_usd
                or intent.reserved_cash_usd
                or 0
            )
        if action in {"SELL", "EXIT"} and intent.confirmed_at is not None:
            confirmed_exits[market_id] = confirmed_exits.get(market_id, 0) + float(
                intent.confirmed_release_usd or 0
            )
    return pending_buys, confirmed_exits


def _blocked_stage(
    run: Bullpen008RunRecord,
    *,
    stage_number: int,
    stage_name: str,
    reason: str,
) -> Bullpen008StageOutputRecord:
    started = datetime.now(UTC)
    return _stage_record(
        run=run,
        stage_number=stage_number,
        stage_name=stage_name,
        started_at=started,
        status="blocked",
        pass_condition="Previous-stage output must pass before this stage can run.",
        inputs={"previous_stage_status": "failed_or_blocked"},
        calculations={},
        outputs={},
        rejections=[],
        warnings=[],
        block_reason=reason,
    )


@celery.task(
    bind=True,
    name=CELERY_TASK_NAME,
    autoretry_for=(),
    soft_time_limit=3300,
    time_limit=3600,
)
def execute_bullpen008_shadow_run(self, run_id: str) -> str:
    redis_client = _redis()
    lock_token = str(uuid4())
    lock_key = _run_lock_key(run_id)
    acquired = bool(
        redis_client.set(lock_key, lock_token, nx=True, ex=RUN_LOCK_TTL_SECONDS)
    )
    if not acquired:
        return "duplicate-suppressed"
    try:
        with SyncSessionLocal() as session:
            run = session.execute(
                select(Bullpen008RunRecord)
                .options(selectinload(Bullpen008RunRecord.stages))
                .where(
                    Bullpen008RunRecord.id == run_id,
                    Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
                )
            ).scalar_one_or_none()
            if run is None:
                return "missing-run"
            if run.status in {"completed", "failed"}:
                return run.status
            settings = Bullpen008Settings.model_validate(run.settings_snapshot)
            user_id = run.user_id
            run.status = "running"
            run.summary = "Bullpen 008 shadow run is executing Stages 1-4."
            run.task_metadata = {
                **dict(run.task_metadata),
                "celery_task_id": self.request.id,
                "worker_started_at": datetime.now(UTC).isoformat(),
                "queue": CELERY_QUEUE,
                "redis_lock_key": lock_key,
            }
            session.commit()

        # Stage 1
        stage1_started = datetime.now(UTC)
        try:
            markets, positions, wallet_snapshot, scan_metadata = asyncio.run(
                _capture_stage1_inputs(settings)
            )
            stage1 = build_stage1_output(
                markets,
                positions,
                settings=settings,
                now=stage1_started,
                universe_complete=bool(scan_metadata["complete_universe"]),
                universe_warnings=[
                    str(value)
                    for value in (scan_metadata.get("warning"),)
                    if value
                ],
            )
            stage1_status = "finished" if stage1["pass_condition_met"] else "failed"
            with SyncSessionLocal() as session:
                run = session.execute(
                    select(Bullpen008RunRecord)
                    .options(selectinload(Bullpen008RunRecord.stages))
                    .where(Bullpen008RunRecord.id == run_id)
                ).scalar_one()
                run.wallet_snapshot = wallet_snapshot
                record = _stage_record(
                    run=run,
                    stage_number=1,
                    stage_name="Discover & Hard Filters",
                    started_at=stage1_started,
                    status=stage1_status,
                    pass_condition=str(stage1["pass_condition"]),
                    inputs={
                        "scan_started_at": stage1_started.isoformat(),
                        "market_universe": markets,
                        "active_wallet_positions": positions,
                        "saved_filters": settings.model_dump(mode="json"),
                        "source_scan": scan_metadata,
                    },
                    calculations={
                        "accounting_identity": "scanned = accepted + rejected + data_errors",
                        "case_insensitive_custom_phrase_matching": True,
                        "active_position_monitoring_override": True,
                    },
                    outputs={
                        "rows": stage1["rows"],
                        "metrics": stage1["metrics"],
                        "duplicates": stage1["duplicates"],
                        "universe_complete": stage1["universe_complete"],
                    },
                    rejections=list(stage1["rejections"]),
                    warnings=[
                        *list(stage1["universe_warnings"]),
                        *[
                            value
                            for value in [
                                wallet_snapshot.get("balance", {}).get("message")
                            ]
                            if value
                            and wallet_snapshot.get("balance", {}).get("status")
                            != "ready"
                        ],
                    ],
                    block_reason=None
                    if stage1_status == "finished"
                    else "Stage 1 did not capture a complete source universe or could not account for every market exactly once.",
                )
                session.add(record)
                session.commit()
        except Exception as exc:
            logger.exception("Bullpen 008 Stage 1 failed for %s", run_id)
            with SyncSessionLocal() as session:
                run = session.execute(
                    select(Bullpen008RunRecord)
                    .options(selectinload(Bullpen008RunRecord.stages))
                    .where(Bullpen008RunRecord.id == run_id)
                ).scalar_one()
                record = _stage_record(
                    run=run,
                    stage_number=1,
                    stage_name="Discover & Hard Filters",
                    started_at=stage1_started,
                    status="failed",
                    pass_condition="The complete source universe was captured and every scanned market is exactly once in accepted, rejected or data-error accounting.",
                    inputs={"scan_started_at": stage1_started.isoformat()},
                    calculations={},
                    outputs={},
                    rejections=[],
                    warnings=[],
                    block_reason=str(exc),
                )
                session.add(record)
                session.commit()
            stage1 = {"rows": [], "pass_condition_met": False}
            stage1_status = "failed"

        # Stage 2
        stage2_status = "blocked"
        stage2: dict[str, object] = {"rows": [], "pass_condition_met": False}
        if stage1_status != "finished":
            with SyncSessionLocal() as session:
                run = session.execute(
                    select(Bullpen008RunRecord)
                    .options(selectinload(Bullpen008RunRecord.stages))
                    .where(Bullpen008RunRecord.id == run_id)
                ).scalar_one()
                session.add(
                    _blocked_stage(
                        run,
                        stage_number=2,
                        stage_name="Probability & Structural Risk",
                        reason="Stage 1 did not pass.",
                    )
                )
                session.commit()
        else:
            stage2_started = datetime.now(UTC)
            stage2_input_rows = _stage2_input_rows(list(stage1["rows"]))
            prompt = build_probability_risk_prompt(stage2_input_rows)
            raw_provider_response: str | None = None
            provider_attempts: list[dict[str, object]] = []
            try:
                provider_name, model_name = _provider_target(settings)
                provider = ProviderFactory.create(provider_name)
                response = provider.generate(
                    prompt=prompt, model=model_name
                )
                raw_provider_response = response.content
                parsed = parse_probability_risk_response(response.content)
                stage2 = normalize_stage2_rows(
                    stage2_input_rows,
                    parsed,
                    settings=settings,
                    now=stage2_started,
                )
                provider_attempts = [
                    {
                        "attempt": 1,
                        "kind": "complete_universe",
                        "prompt": prompt,
                        "raw_provider_response": response.content,
                        "provider_usage": _provider_usage(response),
                        "missing_market_ids": stage2["missing_market_ids"],
                        "validation_errors": stage2["validation_errors"],
                    }
                ]
                for repair_number in range(1, 3):
                    repair_market_ids = _stage2_repair_market_ids(stage2)
                    if not repair_market_ids:
                        break
                    repair_rows = [
                        row
                        for row in stage2_input_rows
                        if str(row.get("market_id") or "") in repair_market_ids
                    ]
                    repair_prompt = (
                        build_probability_risk_prompt(repair_rows)
                        + "\n\nCORRECTION ATTEMPT: The prior response omitted or invalidated "
                        + "the market IDs below. Return strict JSON containing exactly one corrected "
                        + "row for each listed market ID and no other rows. Do not relax any schema, "
                        + "probability-complementarity, evidence or risk requirement.\n"
                        + canonical_json(
                            {
                                "market_ids": repair_market_ids,
                                "prior_validation_errors": stage2[
                                    "validation_errors"
                                ],
                            }
                        )
                    )
                    repair_response = provider.generate(
                        prompt=repair_prompt, model=model_name
                    )
                    raw_provider_response = repair_response.content
                    repair_parsed = parse_probability_risk_response(
                        repair_response.content
                    )
                    parsed = _merge_stage2_provider_rows(
                        parsed,
                        repair_parsed,
                        repair_market_ids=repair_market_ids,
                    )
                    stage2 = normalize_stage2_rows(
                        stage2_input_rows,
                        parsed,
                        settings=settings,
                        now=stage2_started,
                    )
                    provider_attempts.append(
                        {
                            "attempt": repair_number + 1,
                            "kind": "targeted_strict_repair",
                            "market_ids": repair_market_ids,
                            "prompt": repair_prompt,
                            "raw_provider_response": repair_response.content,
                            "provider_usage": _provider_usage(repair_response),
                            "missing_market_ids": stage2["missing_market_ids"],
                            "validation_errors": stage2["validation_errors"],
                        }
                    )
                stage2_status = "finished" if stage2["pass_condition_met"] else "failed"
                with SyncSessionLocal() as session:
                    run = session.execute(
                        select(Bullpen008RunRecord)
                        .options(selectinload(Bullpen008RunRecord.stages))
                        .where(Bullpen008RunRecord.id == run_id)
                    ).scalar_one()
                    session.add(
                        _stage_record(
                            run=run,
                            stage_number=2,
                            stage_name="Probability & Structural Risk",
                            started_at=stage2_started,
                            status=stage2_status,
                            pass_condition=str(stage2["pass_condition"]),
                            inputs={
                                "complete_input_packet": stage2_input_rows,
                                "stage1_accounting_row_count": len(
                                    list(stage1["rows"])
                                ),
                                "stage2_eligible_row_count": len(stage2_input_rows),
                                "prompt": prompt,
                                "provider": provider_name,
                                "model": model_name,
                            },
                            calculations={
                                "P_LLM": "max(P_YES, P_NO)",
                                "LLM edge": "P_LLM - current chosen-side Bullpen odds",
                                "Returns/day": "(100 - current chosen-side Bullpen odds) / (days until close + 4)",
                                "Risk score": "0.30U + 0.25A + 0.20T + 0.15D + 0.10I",
                            },
                            outputs={
                                "rows": stage2["rows"],
                                "metrics": stage2["metrics"],
                                "raw_provider_response": response.content,
                                "provider_attempts": provider_attempts,
                                "missing_market_ids": stage2["missing_market_ids"],
                                "unexpected_market_ids": stage2[
                                    "unexpected_market_ids"
                                ],
                                "duplicate_market_ids": stage2[
                                    "duplicate_market_ids"
                                ],
                                "provider_usage": _aggregate_provider_usage(
                                    provider_attempts,
                                    provider=response.provider,
                                    model=response.model,
                                ),
                                "validation_errors": stage2["validation_errors"],
                            },
                            rejections=list(stage2["validation_errors"]),
                            warnings=[
                                f"Stage 2 required {len(provider_attempts) - 1} targeted strict provider repair attempt(s)."
                            ]
                            if len(provider_attempts) > 1
                            else [],
                            block_reason=None
                            if stage2_status == "finished"
                            else "Stage 2 has missing, duplicate or invalid rows.",
                            prompt_version=LLM_PROMPT_VERSION,
                            parser_version=STAGE2_PARSER_VERSION,
                        )
                    )
                    session.commit()
            except Exception as exc:
                logger.exception("Bullpen 008 Stage 2 failed for %s", run_id)
                stage2_status = "failed"
                with SyncSessionLocal() as session:
                    run = session.execute(
                        select(Bullpen008RunRecord)
                        .options(selectinload(Bullpen008RunRecord.stages))
                        .where(Bullpen008RunRecord.id == run_id)
                    ).scalar_one()
                    session.add(
                        _stage_record(
                            run=run,
                            stage_number=2,
                            stage_name="Probability & Structural Risk",
                            started_at=stage2_started,
                            status="failed",
                            pass_condition="Every eligible row has complementary probabilities, evidence status and structural-risk classification.",
                            inputs={"prompt": prompt},
                            calculations={},
                            outputs={
                                "raw_provider_response": raw_provider_response,
                                "provider_attempts": provider_attempts,
                                "validation_errors": [{"error": str(exc)}],
                            },
                            rejections=[{"error": str(exc)}],
                            warnings=[],
                            block_reason=str(exc),
                            prompt_version=LLM_PROMPT_VERSION,
                            parser_version=STAGE2_PARSER_VERSION,
                        )
                    )
                    session.commit()

        # Stage 3
        stage3_status = "blocked"
        stage3: dict[str, object] = {"rows": [], "pass_condition_met": False}
        if stage2_status != "finished":
            with SyncSessionLocal() as session:
                run = session.execute(
                    select(Bullpen008RunRecord)
                    .options(selectinload(Bullpen008RunRecord.stages))
                    .where(Bullpen008RunRecord.id == run_id)
                ).scalar_one()
                session.add(
                    _blocked_stage(
                        run,
                        stage_number=3,
                        stage_name="Cluster & Dependency Map",
                        reason="Stage 2 did not pass.",
                    )
                )
                session.commit()
        else:
            stage3_started = datetime.now(UTC)
            prompt = build_cluster_prompt(list(stage2["rows"]))
            raw_cluster_response: str | None = None
            try:
                provider_name, model_name = _provider_target(settings)
                response = ProviderFactory.create(provider_name).generate(
                    prompt=prompt, model=model_name
                )
                raw_cluster_response = response.content
                parsed = parse_cluster_response(response.content)
                existing_exposure: dict[str, float] = {}
                for position in wallet_snapshot.get("positions", []):
                    if not isinstance(position, dict):
                        continue
                    market_id = str(position.get("market_id") or "")
                    cost_basis = float(position.get("exposure_usd") or 0)
                    liquidation = float(position.get("current_value_usd") or 0)
                    existing_exposure[market_id] = existing_exposure.get(
                        market_id, 0
                    ) + max(cost_basis, liquidation)
                pending_buys, confirmed_exits = _pending_exposures(user_id)
                stage3 = normalize_cluster_rows(
                    list(stage2["rows"]),
                    parsed,
                    existing_exposure_by_market=existing_exposure,
                    pending_buy_exposure_by_market=pending_buys,
                    confirmed_exit_exposure_by_market=confirmed_exits,
                    settings=settings,
                )
                stage3_status = "finished" if stage3["pass_condition_met"] else "failed"
                with SyncSessionLocal() as session:
                    run = session.execute(
                        select(Bullpen008RunRecord)
                        .options(selectinload(Bullpen008RunRecord.stages))
                        .where(Bullpen008RunRecord.id == run_id)
                    ).scalar_one()
                    session.add(
                        _stage_record(
                            run=run,
                            stage_number=3,
                            stage_name="Cluster & Dependency Map",
                            started_at=stage3_started,
                            status=stage3_status,
                            pass_condition=str(stage3["pass_condition"]),
                            inputs={
                                "complete_market_universe": list(stage2["rows"]),
                                "prompt": prompt,
                                "provider": provider_name,
                                "model": model_name,
                                "current_wallet_exposure": existing_exposure,
                                "all_active_007_pending_buys": pending_buys,
                                "confirmed_exits": confirmed_exits,
                            },
                            calculations={
                                "Cluster exposure": "existing exposure + pending buys + proposed buys - confirmed exits",
                                "Exposure at risk": "max(current liquidation value, remaining cost basis)",
                                "transitive_closure": True,
                            },
                            outputs={
                                "rows": stage3["rows"],
                                "metrics": stage3["metrics"],
                                "strict_cluster_exposure": stage3[
                                    "strict_cluster_exposure"
                                ],
                                "common_catalyst_exposure": stage3[
                                    "common_catalyst_exposure"
                                ],
                                "raw_provider_response": response.content,
                                "validation_errors": stage3[
                                    "validation_errors"
                                ],
                            },
                            rejections=list(stage3["unresolved_adjudications"]),
                            warnings=[],
                            block_reason=None
                            if stage3_status == "finished"
                            else "Incomplete, duplicate or unresolved cluster assignment blocks Stage 4.",
                            prompt_version=CLUSTER_PROMPT_VERSION,
                            parser_version=STAGE3_PARSER_VERSION,
                        )
                    )
                    session.commit()
            except Exception as exc:
                logger.exception("Bullpen 008 Stage 3 failed for %s", run_id)
                stage3_status = "failed"
                with SyncSessionLocal() as session:
                    run = session.execute(
                        select(Bullpen008RunRecord)
                        .options(selectinload(Bullpen008RunRecord.stages))
                        .where(Bullpen008RunRecord.id == run_id)
                    ).scalar_one()
                    session.add(
                        _stage_record(
                            run=run,
                            stage_number=3,
                            stage_name="Cluster & Dependency Map",
                            started_at=stage3_started,
                            status="failed",
                            pass_condition="Every market is assigned exactly once and no semantic-cluster adjudication remains unresolved.",
                            inputs={"prompt": prompt},
                            calculations={"transitive_closure": True},
                            outputs={
                                "raw_provider_response": raw_cluster_response,
                                "validation_errors": [{"error": str(exc)}],
                            },
                            rejections=[{"error": str(exc)}],
                            warnings=[],
                            block_reason=str(exc),
                            prompt_version=CLUSTER_PROMPT_VERSION,
                            parser_version=STAGE3_PARSER_VERSION,
                        )
                    )
                    session.commit()

        # Stage 4
        stage4_status = "blocked"
        if stage3_status != "finished":
            with SyncSessionLocal() as session:
                run = session.execute(
                    select(Bullpen008RunRecord)
                    .options(selectinload(Bullpen008RunRecord.stages))
                    .where(Bullpen008RunRecord.id == run_id)
                ).scalar_one()
                session.add(
                    _blocked_stage(
                        run,
                        stage_number=4,
                        stage_name="Portfolio Optimizer & Stress Test",
                        reason="Stage 3 did not pass.",
                    )
                )
                session.commit()
        else:
            stage4_started = datetime.now(UTC)
            balance = wallet_snapshot.get("balance", {})
            available_cash = (
                float(balance.get("available_balance_usd") or 0)
                if isinstance(balance, dict)
                else 0
            )
            portfolio = build_portfolio_target(
                list(stage3["rows"]),
                settings=settings,
                available_cash_usd=available_cash,
                inputs_hash=stable_hash(
                    {
                        "stage3": stage3,
                        "settings": settings.model_dump(mode="json"),
                        "wallet": wallet_snapshot,
                    }
                ),
            )
            stage4_status = "finished" if portfolio["pass_condition_met"] else "failed"
            with SyncSessionLocal() as session:
                run = session.execute(
                    select(Bullpen008RunRecord)
                    .options(selectinload(Bullpen008RunRecord.stages))
                    .where(Bullpen008RunRecord.id == run_id)
                ).scalar_one()
                stage_record = _stage_record(
                    run=run,
                    stage_number=4,
                    stage_name="Portfolio Optimizer & Stress Test",
                    started_at=stage4_started,
                    status=stage4_status,
                    pass_condition=str(portfolio["pass_condition"]),
                    inputs={
                        "stage3_cluster_map": list(stage3["rows"]),
                        "available_cash_usd": available_cash,
                        "portfolio_parameters": settings.model_dump(mode="json"),
                    },
                    calculations={
                        "Selection score": "0.35(normalised edge) + 0.25(normalised Returns/day) + 0.15(evidence/confidence) + 0.15(resolution objectivity) + 0.10(breadth) - risk penalty",
                        "allocation_increment_usd": settings.allocation_increment_usd,
                        "deterministic_optimizer": True,
                        "llm_override_permitted": False,
                    },
                    outputs={
                        "allocations": portfolio["allocations"],
                        "stress_scenarios": portfolio["stress_scenarios"],
                        "certificate": portfolio["certificate"],
                        "metrics": portfolio["metrics"],
                        "portfolio_metrics": portfolio["portfolio_metrics"],
                    },
                    rejections=[
                        row
                        for row in portfolio["allocations"]
                        if row.get("explanation_codes")
                        and not row.get("proposed_buy_usd")
                    ],
                    warnings=[]
                    if available_cash > 0
                    else [
                        "Fresh available cash was unavailable or zero; no new allocation was forced."
                    ],
                    block_reason=None
                    if stage4_status == "finished"
                    else "Portfolio certificate failed one or more deterministic cap or stress checks.",
                )
                session.add(stage_record)
                certificate = dict(portfolio["certificate"])
                session.add(
                    Bullpen008PortfolioCertificateRecord(
                        run_id=run.id,
                        workflow_profile=WORKFLOW_PROFILE,
                        certificate_hash=str(certificate["certificate_hash"]),
                        portfolio_certified=bool(certificate["portfolio_certified"]),
                        payload=certificate,
                    )
                )
                session.commit()

        with SyncSessionLocal() as session:
            run = session.get(Bullpen008RunRecord, run_id)
            if run is None:
                return "missing-run"
            success = stage4_status == "finished"
            run.status = "completed" if success else "failed"
            run.completed_at = datetime.now(UTC)
            run.summary = (
                "Bullpen 008 Phase 1 shadow run completed and the portfolio was certified."
                if success
                else "Bullpen 008 Phase 1 shadow run stopped safely because a stage pass condition was not satisfied."
            )
            run.error_message = (
                None
                if success
                else "One or more Stage 1-4 pass conditions failed; no orders were created."
            )
            run.run_metadata = {
                **dict(run.run_metadata),
                "orders_created": 0,
                "orders_submitted": 0,
                "stage5_status": "disabled_pending_phase2",
                "stage6_status": "disabled_pending_phase2",
            }
            state = session.execute(
                select(Bullpen008StateRecord).where(
                    Bullpen008StateRecord.user_id == run.user_id,
                    Bullpen008StateRecord.workflow_profile == WORKFLOW_PROFILE,
                )
            ).scalar_one_or_none()
            if state is not None:
                state.last_run_at = run.completed_at
                state.last_run_id = run.id
                state.status = (
                    "shadow-ready" if not state.running else "shadow-scheduled"
                )
            session.commit()
        return "completed" if stage4_status == "finished" else "failed-safe"
    finally:
        try:
            if redis_client.get(lock_key) == lock_token:
                redis_client.delete(lock_key)
            with SyncSessionLocal() as session:
                run = session.get(Bullpen008RunRecord, run_id)
                if run is not None:
                    redis_client.delete(_pending_key(run.user_id))
        finally:
            redis_client.close()


def _create_scheduled_run(user_id: int) -> str | None:
    now = datetime.now(UTC)
    with SyncSessionLocal() as session:
        settings_record = session.execute(
            select(Bullpen008SettingsRecord).where(
                Bullpen008SettingsRecord.user_id == user_id,
                Bullpen008SettingsRecord.workflow_profile == WORKFLOW_PROFILE,
            )
        ).scalar_one_or_none()
        state = session.execute(
            select(Bullpen008StateRecord).where(
                Bullpen008StateRecord.user_id == user_id,
                Bullpen008StateRecord.workflow_profile == WORKFLOW_PROFILE,
            )
        ).scalar_one_or_none()
        if (
            settings_record is None
            or state is None
            or not state.running
            or state.paused
        ):
            return None
        settings = Bullpen008Settings.model_validate(settings_record.payload)
        run_id = f"b008-{uuid4().hex}"
        run = Bullpen008RunRecord(
            id=run_id,
            user_id=user_id,
            workflow_profile=WORKFLOW_PROFILE,
            idempotency_key=f"bullpen008:scheduler:{now.isoformat()}",
            status="queued",
            triggered_by="scheduler",
            shadow_mode=True,
            execution_enabled=False,
            started_at=now,
            summary="Bullpen 008 scheduled shadow-mode run queued.",
            code_build_version=os.getenv("APP_COMMIT_SHA")
            or os.getenv("GIT_COMMIT_SHA"),
            settings_snapshot=settings.model_dump(mode="json"),
            wallet_snapshot={},
            task_metadata={
                "task_name": CELERY_TASK_NAME,
                "queue": CELERY_QUEUE,
                "workflow_profile": WORKFLOW_PROFILE,
            },
            run_metadata={"phase": 1, "orders_permitted": False},
        )
        session.add(run)
        state.next_run_at = next_custom_console_schedule_time(
            now,
            start_at=settings.auto_start_at,
            refresh_minutes=settings.auto_refresh_minutes,
        )
        session.commit()
    execute_bullpen008_shadow_run.apply_async(
        args=[run_id], queue=CELERY_QUEUE, task_id=f"bullpen008:{run_id}"
    )
    return run_id


@celery.task(name=CELERY_SCHEDULER_TASK_NAME)
def enqueue_due_bullpen008_runs() -> int:
    now = datetime.now(UTC)
    with SyncSessionLocal() as session:
        user_ids = (
            session.execute(
                select(Bullpen008StateRecord.user_id).where(
                    Bullpen008StateRecord.workflow_profile == WORKFLOW_PROFILE,
                    Bullpen008StateRecord.running.is_(True),
                    Bullpen008StateRecord.paused.is_(False),
                    Bullpen008StateRecord.next_run_at.is_not(None),
                    Bullpen008StateRecord.next_run_at <= now,
                )
            )
            .scalars()
            .all()
        )
    dispatched = 0
    redis_client = _redis()
    try:
        for user_id in user_ids:
            if not redis_client.set(
                _pending_key(user_id),
                "scheduler",
                nx=True,
                ex=PENDING_MARKER_TTL_SECONDS,
            ):
                continue
            if _create_scheduled_run(user_id) is not None:
                dispatched += 1
            else:
                redis_client.delete(_pending_key(user_id))
    finally:
        redis_client.close()
    return dispatched
