from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import UTC, datetime, timedelta
import html
import os
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
    is_active_pending_order_status,
    normalize_order_status,
)
from app.domains.bullpen008.planning import (
    build_action_plan,
    preflight_execution_plan,
)
from app.domains.bullpen008.execution import (
    ProductionBullpen008Adapter,
    execute_certified_action,
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
    Bullpen008ActionPlanRecord,
    Bullpen008AlertRecord,
    Bullpen008ContingentExitActivationRecord,
    Bullpen008ContingentExitPolicyRecord,
    Bullpen008DailyEquityBaselineRecord,
    Bullpen008DrawdownEpisodeRecord,
    Bullpen008EvidencePacketRecord,
    Bullpen008ExecutionAttemptRecord,
    Bullpen008ExecutionEventRecord,
    Bullpen008ExecutionIntentRecord,
    Bullpen008JointLossScenarioRecord,
    Bullpen008LossPreventionAuditRecord,
    Bullpen008PnlAttributionRecord,
    Bullpen008PortfolioCertificateRecord,
    Bullpen008QuoteObservationRecord,
    Bullpen008RegimeChangeEpisodeRecord,
    Bullpen008RiskClassificationRecord,
    Bullpen008RunRecord,
    Bullpen008ScenarioCooldownRecord,
    Bullpen008ScenarioExposureSnapshotRecord,
    Bullpen008ScenarioMembershipRecord,
    Bullpen008SettingsRecord,
    Bullpen008StageOutputRecord,
    Bullpen008StateRecord,
)
from app.domains.bullpen008.risk_controls import (
    detect_regime_change,
    evaluate_contingent_policy,
    evaluate_drawdown,
    validate_evidence_packet,
)
from app.domains.bullpen008.schemas import Bullpen008Settings
from app.domains.polymarket_auto_live.evidence import build_evidence_packet
from app.domains.polymarket_auto_live.rules import evaluate_market_rules
from app.domains.polymarket_auto_live.scanner import ScannedMarket
from app.domains.polymarket.bullpen import BullpenBalanceReader
from app.domains.polymarket_auto_live.console_profile import (
    next_custom_console_schedule_time,
    read_console_wallet_positions_snapshot,
    scan_console_profile_markets,
)
from app.domains.polymarket_auto_live.models import (
    PolymarketAutoLiveOrderIntentRecord,
)
from app.domains.polymarket_auto_live.execution import refresh_execution_quote
from app.domains.polymarket_auto_live.advisory_lock import (
    acquire_bullpen_account_execution_advisory_lock_sync,
)
from app.domains.bullpen_run_audit.provenance import resolve_backend_commit_sha
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
        "start_time": _first(raw, "startDate", "start_time", "eventStart", "startTime"),
        "end_time": _first(raw, "endDate", "end_time", "eventEnd", "endTime") or getattr(market, "close_time", None),
        "resolution_window_hours": _first(raw, "resolutionWindowHours", "resolution_window_hours"),
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
        "market_url": getattr(market, "market_url", None),
        "best_bid_cents": getattr(market, "best_bid_cents", None),
        "best_ask_cents": getattr(market, "best_ask_cents", None),
        "source": "Polymarket Gamma API / Bullpen discover",
    }


def _attach_high_shock_evidence(
    rows: list[dict[str, object]], *, now: datetime, force_refresh: bool = False
) -> list[dict[str, object]]:
    enriched: list[dict[str, object]] = []
    for source in rows:
        row = dict(source)
        if row.get("risk_tier") == "standard_objective" or (
            row.get("evidence_packet") and not force_refresh
        ):
            enriched.append(row)
            continue
        market = ScannedMarket(
            market_id=str(row.get("market_id") or ""),
            question=str(row.get("question") or ""),
            market_url=str(row.get("market_url") or "") or None,
            slug=str(row.get("slug") or "") or None,
            close_time=str(row.get("deadline") or row.get("close_time") or "") or None,
            theme=str(row.get("category") or ""),
            current_yes_odds=float(row["current_yes_odds"]) if isinstance(row.get("current_yes_odds"), (int, float)) else None,
            current_no_odds=float(row["current_no_odds"]) if isinstance(row.get("current_no_odds"), (int, float)) else None,
            volume_usd=float(row["volume"]) if isinstance(row.get("volume"), (int, float)) else None,
            liquidity_usd=float(row["liquidity"]) if isinstance(row.get("liquidity"), (int, float)) else None,
            description=str(row.get("resolution_rules") or "") or None,
            outcome_labels=[str(value) for value in row.get("outcomes", [])],
            event_slug=str(row.get("event_slug") or "") or None,
            best_bid_cents=float(row["best_bid_cents"]) if isinstance(row.get("best_bid_cents"), (int, float)) else None,
            best_ask_cents=float(row["best_ask_cents"]) if isinstance(row.get("best_ask_cents"), (int, float)) else None,
            spread_cents=float(row["spread"]) if isinstance(row.get("spread"), (int, float)) else None,
            raw={},
        )
        try:
            rules = evaluate_market_rules(
                market,
                now=now,
                resolution_text=market.description,
                exact_market_match_verified=True,
            )
            row["evidence_packet"] = build_evidence_packet(
                market, rules, built_at=now.isoformat()
            ).model_dump(mode="json")
        except Exception as exc:
            logger.warning("Bullpen 008 evidence retrieval failed for %s: %s", market.market_id, exc)
            row["evidence_packet"] = {
                "built_at_utc": now.isoformat(),
                "sources": [],
                "retrieval_error": str(exc),
            }
        enriched.append(row)
    return enriched


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
            use_deadline_cursor_pagination=True,
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
    # Preserve every economically present wallet row, including expired,
    # stale/unknown and resolution-pending positions. Stage 4 must classify
    # these rows before Stage 5 can translate a complete target. The upstream
    # wallet reader has already discarded truly closed zero-share rows.
    active_positions = [
        _position_packet(position, quote_timestamp=wallet.fetched_at)
        for position in wallet.positions
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
        "pagination_mode": "gamma-events-deadline-cursor",
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
        phase2_records = (
            session.execute(
                select(Bullpen008ExecutionIntentRecord)
                .join(
                    Bullpen008RunRecord,
                    Bullpen008RunRecord.id
                    == Bullpen008ExecutionIntentRecord.run_id,
                )
                .where(
                    Bullpen008RunRecord.user_id == user_id,
                    Bullpen008ExecutionIntentRecord.workflow_profile
                    == WORKFLOW_PROFILE,
                )
            )
            .scalars()
            .all()
        )
    for intent in records:
        market_id = str(intent.market_id)
        action = str(intent.action).upper()
        status = normalize_order_status(intent.status)
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
    for intent in phase2_records:
        market_id = str(intent.market_id)
        action = str(intent.action_type).upper()
        status = normalize_order_status(intent.status)
        payload = dict(intent.payload or {})
        if action == "BUY" and status in PENDING_ORDER_STATUSES:
            remaining = max(
                0.0,
                float(payload.get("estimated_usd") or 0)
                - float(intent.filled_value_usd or 0),
            )
            pending_buys[market_id] = pending_buys.get(market_id, 0) + remaining
        if action in {"SELL", "FULL_EXIT", "TRIM"} and status == "reconciled":
            confirmed_exits[market_id] = confirmed_exits.get(market_id, 0) + float(
                intent.filled_value_usd or payload.get("estimated_usd") or 0
            )
    return pending_buys, confirmed_exits


def _pending_order_packets(user_id: int) -> list[dict[str, object]]:
    """Read both 007 and 008 durable orders without mutating either profile."""
    packets: list[dict[str, object]] = []
    with SyncSessionLocal() as session:
        legacy = (
            session.execute(
                select(PolymarketAutoLiveOrderIntentRecord).where(
                    PolymarketAutoLiveOrderIntentRecord.user_id == user_id
                )
            )
            .scalars()
            .all()
        )
        phase2 = (
            session.execute(
                select(Bullpen008ExecutionIntentRecord)
                .join(Bullpen008RunRecord, Bullpen008RunRecord.id == Bullpen008ExecutionIntentRecord.run_id)
                .where(
                    Bullpen008RunRecord.user_id == user_id,
                    Bullpen008ExecutionIntentRecord.workflow_profile == WORKFLOW_PROFILE,
                )
            )
            .scalars()
            .all()
        )
    for intent in legacy:
        if not is_active_pending_order_status(intent.status):
            continue
        packets.append(
            {
                "profile": "bullpen007",
                "intent_id": intent.id,
                "market_id": intent.market_id,
                "condition_id": intent.condition_id,
                "side": intent.side,
                "action": intent.action,
                "status": normalize_order_status(intent.status),
                "current_order_usd": intent.current_order_usd,
                "requested_order_usd": intent.requested_order_usd,
                "remote_order_id": intent.remote_order_id,
                "remaining_shares": intent.remaining_shares,
            }
        )
    for intent in phase2:
        if not is_active_pending_order_status(intent.status):
            continue
        packets.append(
            {
                "profile": WORKFLOW_PROFILE,
                "intent_id": intent.id,
                "market_id": intent.market_id,
                "condition_id": intent.condition_id,
                "side": intent.side,
                "action": intent.action_type,
                "status": normalize_order_status(intent.status),
                "current_order_usd": intent.payload.get("estimated_usd"),
                "remote_order_id": intent.remote_order_id,
                "filled_shares": intent.filled_shares,
            }
        )
    return packets


def _active_loss_prevention_gates(user_id: int, *, now: datetime) -> dict[str, object]:
    with SyncSessionLocal() as session:
        drawdown = session.execute(
            select(Bullpen008DrawdownEpisodeRecord)
            .where(Bullpen008DrawdownEpisodeRecord.user_id == user_id)
            .order_by(Bullpen008DrawdownEpisodeRecord.activated_at.desc())
            .limit(1)
        ).scalar_one_or_none()
        cooldowns = session.execute(
            select(Bullpen008ScenarioCooldownRecord).where(
                Bullpen008ScenarioCooldownRecord.user_id == user_id,
                Bullpen008ScenarioCooldownRecord.status == "ACTIVE",
                Bullpen008ScenarioCooldownRecord.ends_at > now,
            )
        ).scalars().all()
        active_regimes = session.execute(
            select(Bullpen008RegimeChangeEpisodeRecord).where(
                Bullpen008RegimeChangeEpisodeRecord.user_id == user_id,
                Bullpen008RegimeChangeEpisodeRecord.status == "ACTIVE_BUY_FREEZE",
                Bullpen008RegimeChangeEpisodeRecord.recovered_at.is_(None),
            )
        ).scalars().all()
    return {
        "drawdown_state": drawdown.status if drawdown is not None else "NORMAL",
        "drawdown_evidence": drawdown.payload if drawdown is not None else {},
        "active_scenario_cooldown_ids": sorted({row.scenario_id for row in cooldowns}),
        "active_regime_scenario_ids": sorted({row.scenario_id for row in active_regimes}),
        "active_regime_evidence": [dict(row.payload or {}) for row in active_regimes],
    }


async def _refresh_wallet_snapshot(
    settings: Bullpen008Settings, *, caller_source: str
) -> dict[str, object]:
    wallet, balance = await asyncio.gather(
        read_console_wallet_positions_snapshot(
            force_fresh=True,
            caller_source=caller_source,
            max_age_seconds=settings.wallet_freshness_seconds,
        ),
        BullpenBalanceReader().refresh(wait_for_login=False),
    )
    return {
        "source": wallet.source,
        "fetched_at": wallet.fetched_at,
        "freshness_state": wallet.freshness_state,
        "account_identity": wallet.account_identity,
        "credential_artifact": wallet.credential_artifact,
        "raw_position_count": wallet.raw_position_count,
        "positions": [
            _position_packet(position, quote_timestamp=wallet.fetched_at)
            for position in wallet.positions
        ],
        "balance": balance.model_dump(mode="json"),
        "freshness_proof": {
            "auth_checked_at": wallet.auth_checked_at,
            "cli_version": wallet.cli_version,
            "position_classifier_version": wallet.position_classifier_version,
            "caller_source": caller_source,
        },
    }


async def _refresh_stage6_quotes(
    plan: dict[str, object], *, activated_contingent_action_ids: set[str] | None = None
) -> dict[str, dict[str, object]]:
    activated_contingent_action_ids = activated_contingent_action_ids or set()
    actions = [
        row
        for key in ("full_exits", "trims", "buys")
        for row in plan.get(key, [])
        if isinstance(row, dict)
    ]
    actions.extend(
        row
        for row in plan.get("dormant_contingent_exits", [])
        if isinstance(row, dict)
        and str(row.get("action_id") or "") in activated_contingent_action_ids
    )

    async def one(action: dict[str, object]) -> tuple[str, dict[str, object]]:
        market_id = str(action.get("market_id") or "")
        refreshed = await refresh_execution_quote(
            slug=str(action.get("slug") or "") or None,
            side=str(action.get("side") or "YES"),
        )
        market = refreshed.market
        raw = dict(getattr(market, "raw", None) or {}) if market else {}
        return market_id, {
            "current_odds": refreshed.current_price_cents,
            "spread_cents": refreshed.spread_cents,
            "open": bool(
                market is not None
                and raw.get("closed") is not True
                and raw.get("active", True) is not False
                and raw.get("acceptingOrders", raw.get("accepting_orders", True)) is not False
            ),
            "liquidity_usd": getattr(market, "liquidity_usd", None) if market else None,
            "quote_timestamp": datetime.now(UTC).isoformat(),
            "source": "fresh Stage 6 Bullpen quote",
        }

    if not actions:
        return {}
    return dict(await asyncio.gather(*(one(action) for action in actions)))


async def _execute_live_plan(
    *,
    run_id: str,
    user_id: int,
    plan: dict[str, object],
    stage4_certificate: dict[str, object],
    settings: Bullpen008Settings,
    activated_contingent_action_ids: set[str] | None = None,
) -> dict[str, object]:
    """Execute certified actions in dependency order with durable evidence."""
    if not (
        settings.execution_enabled
        and settings.live_control_armed
        and settings.execution_mode == "live"
        and os.getenv("BULLPEN008_LIVE_EXECUTION_ENABLED", "").strip().lower()
        in {"1", "true", "yes"}
    ):
        raise RuntimeError("BULLPEN008_LIVE_CONTROL_NOT_ARMED")
    account_identity = str(plan.get("account_identity") or "")
    if not account_identity:
        raise RuntimeError("BULLPEN008_ACCOUNT_IDENTITY_MISSING")

    adapter = ProductionBullpen008Adapter()
    statuses: dict[str, str] = {}
    results: list[dict[str, object]] = []
    activated_contingent_action_ids = activated_contingent_action_ids or set()
    action_rows = [
        action
        for key in ("claims", "order_cancellations", "full_exits", "trims", "buys")
        for action in plan.get(key, [])
        if isinstance(action, dict)
    ]
    action_rows.extend(
        action
        for action in plan.get("dormant_contingent_exits", [])
        if isinstance(action, dict)
        and str(action.get("action_id") or "") in activated_contingent_action_ids
    )

    async def persist_intent(payload: dict[str, object]) -> None:
        with SyncSessionLocal() as session:
            intent_id = str(payload["intent_id"])
            record = session.get(Bullpen008ExecutionIntentRecord, intent_id)
            if record is None:
                record = Bullpen008ExecutionIntentRecord(
                    id=intent_id,
                    run_id=run_id,
                    workflow_profile=WORKFLOW_PROFILE,
                    plan_id=str(payload["plan_id"]),
                    action_id=str(payload["action_id"]),
                    action_type=str(payload["action_type"]),
                    market_id=str(payload["market_id"]),
                    condition_id=str(payload.get("condition_id") or "") or None,
                    side=str(payload.get("side") or "") or None,
                    status="Submitting",
                    idempotency_key=str(payload["idempotency_key"]),
                    request_hash=str(payload["request_hash"]),
                    stage4_certificate_hash=str(payload["stage4_certificate_hash"]),
                    stage5_plan_hash=str(payload["stage5_plan_hash"]),
                    attempt_count=int(payload.get("attempt_number") or 1),
                    payload=dict(payload),
                )
                session.add(record)
            else:
                record.status = "Submitting"
                record.attempt_count = max(record.attempt_count, int(payload.get("attempt_number") or 1))
                record.payload = {**dict(record.payload), **payload}
            session.flush()
            attempt_number = record.attempt_count
            existing_attempt = session.execute(
                select(Bullpen008ExecutionAttemptRecord).where(
                    Bullpen008ExecutionAttemptRecord.intent_id == intent_id,
                    Bullpen008ExecutionAttemptRecord.attempt_number == attempt_number,
                )
            ).scalar_one_or_none()
            if existing_attempt is None:
                session.add(
                    Bullpen008ExecutionAttemptRecord(
                        intent_id=intent_id,
                        attempt_number=attempt_number,
                        request_hash=record.request_hash,
                        started_at=datetime.now(UTC),
                        result_status="Submitting",
                        sanitized_request=dict(payload.get("sanitized_request") or {}),
                        sanitized_response={},
                        reconciliation={},
                    )
                )
            session.commit()

    async def persist_transition(
        payload: dict[str, object], status: str, evidence: dict[str, object]
    ) -> None:
        with SyncSessionLocal() as session:
            record = session.get(Bullpen008ExecutionIntentRecord, str(payload["intent_id"]))
            if record is None:
                raise RuntimeError("DURABLE_INTENT_MISSING_BEFORE_TRANSITION")
            previous = record.status
            record.status = status
            remote_id = evidence.get("remote_id")
            if remote_id:
                record.remote_order_id = str(remote_id)
                if record.first_submitted_at is None:
                    record.first_submitted_at = datetime.now(UTC)
            record.blocker_code = str(evidence.get("error_code") or "") or None
            record.failure_message = str(evidence.get("message") or "") or None
            record.retryable = status == "Recoverable"
            record.payload = {**dict(record.payload), "last_evidence": evidence}
            if status in {"Reconciled", "Filled"}:
                record.reconciled_at = datetime.now(UTC)
                record.terminal_at = record.reconciled_at
            elif status in {"Failed", "Blocked", "Cancelled"}:
                record.terminal_at = datetime.now(UTC)
            attempt = session.execute(
                select(Bullpen008ExecutionAttemptRecord).where(
                    Bullpen008ExecutionAttemptRecord.intent_id == record.id,
                    Bullpen008ExecutionAttemptRecord.attempt_number == record.attempt_count,
                )
            ).scalar_one_or_none()
            if attempt is not None:
                attempt.result_status = status
                if isinstance(evidence.get("response"), dict):
                    attempt.sanitized_response = dict(evidence["response"])
                if isinstance(evidence.get("reconciliation"), dict):
                    attempt.reconciliation = dict(evidence["reconciliation"])
                if status in {"Reconciled", "Filled", "PartiallyFilled", "Failed", "Recoverable", "Blocked", "Cancelled"}:
                    attempt.completed_at = datetime.now(UTC)
                attempt.error_code = str(evidence.get("error_code") or "") or None
                attempt.error_message = str(evidence.get("message") or "") or None
                attempt.remote_order_id = str(evidence.get("remote_id") or "") or attempt.remote_order_id
            session.add(
                Bullpen008ExecutionEventRecord(
                    intent_id=record.id,
                    workflow_profile=WORKFLOW_PROFILE,
                    from_status=previous,
                    to_status=status,
                    reason_code=str(evidence.get("error_code") or evidence.get("reason") or "") or None,
                    evidence=evidence,
                    occurred_at=datetime.now(UTC),
                )
            )
            session.commit()

    for action in sorted(action_rows, key=lambda row: int(row.get("priority") or 999)):
        live_wallet = await _refresh_wallet_snapshot(
            settings, caller_source=f"bullpen008-stage6-action-{action.get('action_id')}"
        )
        quotes = await _refresh_stage6_quotes(
            {
                **plan,
                "claims": [],
                "order_cancellations": [],
                "full_exits": [action]
                if action.get("action_type") == "full_exit"
                else [],
                "trims": [action] if action.get("action_type") == "trim" else [],
                "buys": [action] if action.get("action_type") == "buy" else [],
            },
            activated_contingent_action_ids={str(action.get("action_id"))}
            if action.get("action_type") == "contingent_exit"
            else set(),
        )
        preflight = preflight_execution_plan(
            plan=plan,
            stage4_certificate=stage4_certificate,
            live_wallet_snapshot=live_wallet,
            quotes_by_market=quotes,
            pending_orders=_pending_order_packets(user_id),
            settings=settings,
            execution_mode="live",
            emergency_stop=False,
            prerequisite_statuses=statuses,
            activated_contingent_action_ids={str(action.get("action_id"))}
            if action.get("action_type") == "contingent_exit"
            else set(),
        )
        action_preflight = next(
            (row for row in preflight["actions"] if row.get("action_id") == action.get("action_id")),
            {"status": "Blocked", "blocker_codes": ["ACTION_MISSING_FROM_PREFLIGHT"]},
        )
        if action_preflight.get("status") in {"Blocked", "Recoverable"}:
            result = {
                "action_id": action.get("action_id"),
                "status": action_preflight.get("status"),
                "blocker_code": "+".join(action_preflight.get("blocker_codes", [])),
                "pre_submit_checks": action_preflight.get("pre_submit_checks", {}),
            }
            results.append(result)
            statuses[str(action.get("action_id"))] = "Blocked"
            continue
        existing = None
        with SyncSessionLocal() as session:
            record = session.execute(
                select(Bullpen008ExecutionIntentRecord).where(
                    Bullpen008ExecutionIntentRecord.workflow_profile == WORKFLOW_PROFILE,
                    Bullpen008ExecutionIntentRecord.action_id == action.get("action_id"),
                )
            ).scalar_one_or_none()
            if record is not None:
                existing = dict(record.payload)
                existing.update(
                    {
                        "intent_id": record.id,
                        "status": record.status,
                        "remote_order_id": record.remote_order_id,
                        "remote_transaction_id": record.remote_transaction_id,
                        "idempotency_key": record.idempotency_key,
                        "retryable": record.retryable,
                    }
                )
        if existing and not (
            existing.get("remote_order_id") or existing.get("remote_transaction_id")
        ):
            existing_status = str(existing.get("status") or "")
            if existing_status in {"Submitting", "Submitted", "Confirming", "Recoverable"} and not existing.get("retryable"):
                result = {
                    "action_id": action.get("action_id"),
                    "status": "Recoverable",
                    "blocker_code": "AMBIGUOUS_PRIOR_WRITE_NO_RESUBMIT",
                    "resubmitted": False,
                }
                results.append(result)
                statuses[str(action.get("action_id"))] = "Recoverable"
                continue
            if existing_status in {"Reconciled", "Filled", "Failed", "Blocked", "Cancelled"}:
                result = {
                    "action_id": action.get("action_id"),
                    "status": existing_status,
                    "blocker_code": "ACTION_ALREADY_TERMINAL",
                    "resubmitted": False,
                }
                results.append(result)
                statuses[str(action.get("action_id"))] = existing_status
                continue
        fence = acquire_bullpen_account_execution_advisory_lock_sync(account_identity)
        if fence is None:
            result = {"action_id": action.get("action_id"), "status": "Blocked", "blocker_code": "ACCOUNT_EXECUTION_LOCK_BUSY"}
        else:
            try:
                if not fence.is_healthy():
                    raise RuntimeError("ACCOUNT_EXECUTION_LOCK_LOST")
                # The account-wide fence closes the last race with Bullpen 007
                # or another 008 worker. Refresh and re-run every guard while
                # the fence is held, immediately before the irreversible call.
                locked_wallet = await _refresh_wallet_snapshot(
                    settings,
                    caller_source=(
                        "bullpen008-stage6-locked-"
                        f"{action.get('action_id')}"
                    ),
                )
                locked_quotes = await _refresh_stage6_quotes(
                    {
                        **plan,
                        "claims": [],
                        "order_cancellations": [],
                        "full_exits": [action]
                        if action.get("action_type") == "full_exit"
                        else [],
                        "trims": [action]
                        if action.get("action_type") == "trim"
                        else [],
                        "buys": [action]
                        if action.get("action_type") == "buy"
                        else [],
                    },
                    activated_contingent_action_ids={str(action.get("action_id"))}
                    if action.get("action_type") == "contingent_exit"
                    else set(),
                )
                with SyncSessionLocal() as session:
                    state = session.execute(
                        select(Bullpen008StateRecord).where(
                            Bullpen008StateRecord.user_id == user_id,
                            Bullpen008StateRecord.workflow_profile
                            == WORKFLOW_PROFILE,
                        )
                    ).scalar_one()
                    emergency_stop = bool(
                        dict(state.payload or {}).get("emergency_stop", False)
                    )
                locked_preflight = preflight_execution_plan(
                    plan=plan,
                    stage4_certificate=stage4_certificate,
                    live_wallet_snapshot=locked_wallet,
                    quotes_by_market=locked_quotes,
                    pending_orders=_pending_order_packets(user_id),
                    settings=settings,
                    execution_mode="live",
                    emergency_stop=emergency_stop,
                    prerequisite_statuses=statuses,
                    activated_contingent_action_ids={str(action.get("action_id"))}
                    if action.get("action_type") == "contingent_exit"
                    else set(),
                )
                locked_action_preflight = next(
                    (
                        row
                        for row in locked_preflight["actions"]
                        if row.get("action_id") == action.get("action_id")
                    ),
                    {
                        "status": "Blocked",
                        "blocker_codes": ["ACTION_MISSING_FROM_LOCKED_PREFLIGHT"],
                    },
                )
                if locked_action_preflight.get("status") in {"Blocked", "Recoverable"}:
                    result = {
                        "action_id": action.get("action_id"),
                        "status": locked_action_preflight.get("status"),
                        "blocker_code": "+".join(
                            locked_action_preflight.get("blocker_codes", [])
                        ),
                        "pre_submit_checks": locked_action_preflight.get(
                            "pre_submit_checks", {}
                        ),
                    }
                else:
                    result = await execute_certified_action(
                        action=action,
                        plan=plan,
                        stage4_certificate=stage4_certificate,
                        preflight=locked_action_preflight,
                        adapter=adapter,
                        persist_intent=persist_intent,
                        persist_transition=persist_transition,
                        existing_intent=existing,
                    )
            finally:
                fence.release()
        results.append(result)
        statuses[str(action.get("action_id"))] = str(result.get("status") or "Failed")

    counters = {
        "planned": len(action_rows),
        "risk_certified": sum(1 for row in results if row.get("status") not in {"Blocked"}),
        "ready": 0,
        "durable_intents": sum(1 for row in results if row.get("intent_id")),
        "submitted": sum(1 for row in results if row.get("remote_order_id")),
        "confirmed": sum(1 for row in results if row.get("status") in {"Filled", "Reconciled"}),
        "partially_filled": sum(1 for row in results if row.get("status") == "PartiallyFilled"),
        "blocked": sum(1 for row in results if row.get("status") == "Blocked"),
        "failed": sum(1 for row in results if row.get("status") == "Failed"),
        "recoverable": sum(1 for row in results if row.get("status") == "Recoverable"),
        "reconciled": sum(1 for row in results if row.get("status") == "Reconciled"),
    }
    from app.domains.bullpen008.planning import derive_execution_status

    terminal_status, terminal_reason = derive_execution_status(
        counters=counters, execution_mode="live"
    )
    return {
        "execution_mode": "live",
        "actions": results,
        "counters": counters,
        "terminal_status": terminal_status,
        "terminal_reason": terminal_reason,
        "orders_submitted": counters["submitted"],
        "remote_writes_permitted": True,
    }


def _execution_audit_packets(run_id: str) -> tuple[list[dict[str, object]], list[dict[str, object]], list[dict[str, object]]]:
    with SyncSessionLocal() as session:
        intents = session.execute(
            select(Bullpen008ExecutionIntentRecord).where(
                Bullpen008ExecutionIntentRecord.run_id == run_id,
                Bullpen008ExecutionIntentRecord.workflow_profile == WORKFLOW_PROFILE,
            )
        ).scalars().all()
        intent_ids = [intent.id for intent in intents]
        attempts = (
            session.execute(
                select(Bullpen008ExecutionAttemptRecord).where(
                    Bullpen008ExecutionAttemptRecord.intent_id.in_(intent_ids)
                )
            ).scalars().all()
            if intent_ids else []
        )
        events = (
            session.execute(
                select(Bullpen008ExecutionEventRecord).where(
                    Bullpen008ExecutionEventRecord.intent_id.in_(intent_ids),
                    Bullpen008ExecutionEventRecord.workflow_profile == WORKFLOW_PROFILE,
                )
            ).scalars().all()
            if intent_ids else []
        )
    return (
        [
            {
                "intent_id": row.id, "action_id": row.action_id, "action_type": row.action_type,
                "market_id": row.market_id, "side": row.side, "status": row.status,
                "attempt_count": row.attempt_count, "idempotency_key": row.idempotency_key,
                "request_hash": row.request_hash, "remote_order_id": row.remote_order_id,
                "remote_transaction_id": row.remote_transaction_id, "filled_shares": row.filled_shares,
                "filled_value_usd": row.filled_value_usd, "average_price_cents": row.average_price_cents,
                "fees_usd": row.fees_usd, "blocker_code": row.blocker_code,
                "failure_message": row.failure_message, "retryable": row.retryable,
                "first_submitted_at": row.first_submitted_at.isoformat() if row.first_submitted_at else None,
                "reconciled_at": row.reconciled_at.isoformat() if row.reconciled_at else None,
            }
            for row in intents
        ],
        [
            {
                "intent_id": row.intent_id, "attempt_number": row.attempt_number,
                "request_hash": row.request_hash, "started_at": row.started_at.isoformat(),
                "completed_at": row.completed_at.isoformat() if row.completed_at else None,
                "result_status": row.result_status, "remote_order_id": row.remote_order_id,
                "remote_transaction_id": row.remote_transaction_id, "error_code": row.error_code,
                "error_message": row.error_message, "sanitized_request": row.sanitized_request,
                "sanitized_response": row.sanitized_response, "reconciliation": row.reconciliation,
            }
            for row in attempts
        ],
        [
            {
                "intent_id": row.intent_id, "from_status": row.from_status,
                "to_status": row.to_status, "reason_code": row.reason_code,
                "evidence": row.evidence, "occurred_at": row.occurred_at.isoformat(),
            }
            for row in events
        ],
    )


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


def _persist_loss_prevention_artifacts(
    session,
    *,
    run: Bullpen008RunRecord,
    stage1: dict[str, object],
    stage2: dict[str, object],
    stage3: dict[str, object],
    portfolio: dict[str, object] | None,
    plan: dict[str, object] | None,
) -> None:
    """Persist the P0 audit projection without becoming a portfolio authority."""
    if session.execute(
        select(Bullpen008RiskClassificationRecord.id).where(
            Bullpen008RiskClassificationRecord.run_id == run.id
        ).limit(1)
    ).scalar_one_or_none() is not None:
        return
    now = datetime.now(UTC)
    for row in stage1.get("rows", []):
        if not isinstance(row, dict) or not row.get("market_id"):
            continue
        session.add(
            Bullpen008RiskClassificationRecord(
                user_id=run.user_id,
                run_id=run.id,
                workflow_profile=WORKFLOW_PROFILE,
                market_id=str(row["market_id"]),
                classifier_version=str(row.get("classifier_version") or row.get("risk_classifier_version") or "unknown"),
                risk_tier=str(row.get("risk_tier") or "standard_objective"),
                payload={
                    "matched_evidence": row.get("risk_classification_evidence", {}),
                    "rejection_codes": row.get("risk_rejection_codes", []),
                    "accepted_monitoring": row.get("accounting_status") == "accepted_monitoring",
                    "new_entry_enabled": row.get("new_entry_enabled", False),
                },
            )
        )
    for row in stage2.get("rows", []):
        if not isinstance(row, dict) or not row.get("market_id"):
            continue
        evidence = row.get("evidence_validation")
        if not isinstance(evidence, dict):
            evidence = {}
        packet_hash = str(evidence.get("packet_hash") or stable_hash(evidence))
        session.add(
            Bullpen008EvidencePacketRecord(
                user_id=run.user_id,
                run_id=run.id,
                market_id=str(row["market_id"]),
                packet_hash=packet_hash,
                status="complete" if evidence.get("evidence_complete") else "blocked",
                fetched_at=now,
                payload=evidence,
            )
        )
    scenarios = [row for row in stage3.get("joint_loss_scenarios", []) if isinstance(row, dict)]
    for scenario in scenarios:
        scenario_id = str(scenario.get("scenario_id") or "")
        if not scenario_id:
            continue
        session.add(
            Bullpen008JointLossScenarioRecord(
                user_id=run.user_id,
                run_id=run.id,
                workflow_profile=WORKFLOW_PROFILE,
                scenario_id=scenario_id,
                scenario_version=str(scenario.get("scenario_version") or "unknown"),
                status=str(scenario.get("adjudication_status") or "unresolved"),
                risk_tier=str(scenario.get("risk_tier") or "standard_objective"),
                payload=scenario,
            )
        )
        for market_id in scenario.get("affected_market_ids", []):
            session.add(
                Bullpen008ScenarioMembershipRecord(
                    user_id=run.user_id,
                    run_id=run.id,
                    scenario_id=scenario_id,
                    market_id=str(market_id),
                    payload={
                        "loss_direction": dict(scenario.get("loss_direction_by_market") or {}).get(str(market_id)),
                        "deterministic_links": scenario.get("deterministic_links", []),
                        "semantic_links": scenario.get("semantic_links", []),
                    },
                )
            )
        session.add(
            Bullpen008ScenarioExposureSnapshotRecord(
                user_id=run.user_id,
                run_id=run.id,
                scenario_id=scenario_id,
                observed_at=now,
                payload={
                    key: scenario.get(key)
                    for key in (
                        "existing_loss_at_risk_usd",
                        "pending_loss_at_risk_usd",
                        "target_loss_at_risk_usd",
                        "effective_scenario_cap_usd",
                    )
                },
            )
        )
    if portfolio is None:
        return
    for stress in portfolio.get("joint_scenario_stress", []):
        if not isinstance(stress, dict) or not stress.get("scenario_id"):
            continue
        session.add(
            Bullpen008ScenarioExposureSnapshotRecord(
                user_id=run.user_id,
                run_id=run.id,
                scenario_id=str(stress["scenario_id"]),
                observed_at=now,
                payload={
                    "snapshot_phase": "stage4-certified-target",
                    "target_loss_at_risk_usd": stress.get(
                        "maximum_joint_scenario_loss_usd"
                    ),
                    "effective_scenario_cap_usd": stress.get(
                        "effective_scenario_cap_usd"
                    ),
                    "risk_tier": stress.get("risk_tier"),
                    "result": stress.get("result"),
                    "conservative_gross_loss": stress.get(
                        "conservative_gross_loss", True
                    ),
                },
            )
        )
    policies = [row for row in portfolio.get("contingent_exit_policies", []) if isinstance(row, dict)]
    for policy in policies:
        session.add(
            Bullpen008ContingentExitPolicyRecord(
                user_id=run.user_id,
                run_id=run.id,
                market_id=str(policy.get("affected_market_id") or ""),
                policy_hash=str(policy.get("policy_hash") or ""),
                status="DORMANT",
                payload=policy,
            )
        )
    action_by_market: dict[str, dict[str, object]] = {}
    if plan:
        for action_type in (
            "claims", "order_cancellations", "full_exits", "trims", "buys",
            "dormant_contingent_exits", "holds", "blocked_untradeable",
        ):
            for action in plan.get(action_type, []):
                if isinstance(action, dict) and action.get("market_id"):
                    action_by_market.setdefault(str(action["market_id"]), action)
    intents = {
        row.market_id: row
        for row in session.execute(
            select(Bullpen008ExecutionIntentRecord).where(Bullpen008ExecutionIntentRecord.run_id == run.id)
        ).scalars()
    }
    day = now.date().isoformat()
    wallet_positions = {
        str(row.get("market_id") or ""): row
        for row in (run.wallet_snapshot or {}).get("positions", [])
        if isinstance(row, dict) and row.get("market_id")
    }
    audit_by_market = {
        str(row.get("market_id")): row
        for row in portfolio.get("loss_prevention_audit", [])
        if isinstance(row, dict) and row.get("market_id")
    }
    for allocation in portfolio.get("allocations", []):
        if not isinstance(allocation, dict) or not allocation.get("market_id"):
            continue
        market_id = str(allocation["market_id"])
        position = wallet_positions.get(market_id, {})
        current_exposure = float(allocation.get("current_exposure_usd") or 0)
        current_value = float(
            position.get("current_value_usd")
            or position.get("exposure_usd")
            or current_exposure
        )
        shares = float(position.get("shares") or 0)
        average_price = float(position.get("average_price_cents") or 0)
        cost_basis = shares * average_price / 100 if shares > 0 and average_price > 0 else current_exposure
        unrealized_pnl = current_value - cost_basis
        scenarios_for_market = list(allocation.get("joint_loss_scenario_ids") or [])
        action = action_by_market.get(market_id, {})
        intent = intents.get(market_id)
        pnl_payload = {
            "entry_run_id": run.id,
            "entry_provenance_status": "CURRENT_008_RUN_SNAPSHOT",
            "decision_run_id": run.id,
            "decision": "BUY" if float(allocation.get("proposed_buy_usd") or 0) > 0 else "REDUCE" if float(allocation.get("proposed_sell_usd") or 0) > 0 else "HOLD",
            "contract": market_id,
            "side": allocation.get("chosen_side"),
            "stage4_certificate_id": portfolio.get("certificate", {}).get("certificate_hash"),
            "stage5_action_id": action.get("action_id"),
            "stage6_intent_id": intent.id if intent else None,
            "entry_timestamp": run.started_at.isoformat(),
            "entry_price": average_price or None,
            "entry_amount": round(cost_basis, 2),
            "current_or_exit_price": allocation.get("current_chosen_side_bullpen_odds"),
            "current_value": round(current_value, 2),
            "realized_pnl": 0.0,
            "unrealized_pnl": round(unrealized_pnl, 2),
            "fees": float(intent.fees_usd or 0) if intent else 0.0,
            "maximum_loss_at_entry": allocation.get("maximum_loss_usd"),
            "maximum_remaining_profit_at_entry": allocation.get("maximum_profit_usd"),
            "reward_to_loss_ratio_at_entry": allocation.get("reward_to_loss_ratio"),
            "raw_edge_at_entry": allocation.get("raw_edge_pp"),
            "conservative_edge_at_entry": allocation.get("conservative_edge_pp"),
            "strict_cluster": allocation.get("strict_cluster_id"),
            "common_catalyst_cluster": allocation.get("common_catalyst_cluster_id"),
            "associated_scenario_ids": scenarios_for_market,
            "scenario_loss_at_entry": allocation.get("target_loss_at_risk_usd"),
            "applicable_cap": allocation.get("effective_joint_scenario_cap_usd")
            or allocation.get("effective_scenario_cap_usd"),
            "exit_policy": [p for p in policies if p.get("affected_market_id") == market_id],
            "actual_exit_trigger": intent.payload.get("trigger") if intent else None,
            "trigger_episode": intent.payload.get("trigger_episode") if intent else None,
            "final_reconciliation_status": intent.status if intent else "NO_REMOTE_INTENT",
        }
        session.add(
            Bullpen008PnlAttributionRecord(
                user_id=run.user_id,
                run_id=run.id,
                market_id=market_id,
                scenario_id=str(scenarios_for_market[0]) if scenarios_for_market else None,
                calendar_day=day,
                realized_pnl_usd=0.0,
                unrealized_pnl_usd=float(pnl_payload["unrealized_pnl"]),
                payload=pnl_payload,
            )
        )
        session.add(
            Bullpen008LossPreventionAuditRecord(
                user_id=run.user_id,
                run_id=run.id,
                market_id=market_id,
                payload=audit_by_market.get(market_id, {
                    "market_id": market_id,
                    "counterfactual_estimate": True,
                    "estimate_notice": "Estimated safeguard effects are not realised profit or avoided-loss accounting.",
                }),
            )
        )


@celery.task(
    bind=True,
    name=CELERY_TASK_NAME,
    autoretry_for=(),
    soft_time_limit=3300,
    time_limit=3600,
)
def execute_bullpen008_run(self, run_id: str) -> str:
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
                .options(
                    selectinload(Bullpen008RunRecord.stages),
                    selectinload(Bullpen008RunRecord.action_plan),
                    selectinload(Bullpen008RunRecord.certificate),
                )
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
            run.summary = "Bullpen 008 shadow run is executing the six-stage pipeline."
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
                        "risk_metrics": stage1["risk_metrics"],
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
            stage2_input_rows = _attach_high_shock_evidence(
                _stage2_input_rows(list(stage1["rows"])), now=stage2_started
            )
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
                                "all_active_007_and_008_pending_buys": pending_buys,
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
                                "joint_loss_scenarios": stage3["joint_loss_scenarios"],
                                "scenario_graph_version": stage3["scenario_graph_version"],
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
        stage4_completed_at = datetime.now(UTC)
        portfolio: dict[str, object] | None = None
        stage4_risk_gates: dict[str, object] = {
            "drawdown_state": "NORMAL",
            "active_scenario_cooldown_ids": [],
        }
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
            stage4_risk_gates = _active_loss_prevention_gates(
                user_id, now=stage4_started
            )
            active_cooldowns = set(
                str(value)
                for value in stage4_risk_gates.get(
                    "active_scenario_cooldown_ids", []
                )
            )
            active_regimes = set(
                str(value)
                for value in stage4_risk_gates.get(
                    "active_regime_scenario_ids", []
                )
            )
            stage4_rows = [
                {
                    **row,
                    "drawdown_state": stage4_risk_gates["drawdown_state"],
                    "scenario_cooldown_active": bool(
                        active_cooldowns
                        & set(str(value) for value in row.get("joint_loss_scenario_ids", []))
                    ),
                    "regime_change_active": bool(row.get("regime_change_active"))
                    or bool(
                        active_regimes
                        & set(str(value) for value in row.get("joint_loss_scenario_ids", []))
                    ),
                }
                for row in stage3["rows"]
            ]
            balance = wallet_snapshot.get("balance", {})
            available_cash = (
                float(balance.get("available_balance_usd") or 0)
                if isinstance(balance, dict)
                else 0
            )
            portfolio = build_portfolio_target(
                stage4_rows,
                settings=settings,
                available_cash_usd=available_cash,
                inputs_hash=stable_hash(
                    {
                        "stage3": stage3,
                        "settings": settings.model_dump(mode="json"),
                        "wallet": wallet_snapshot,
                    }
                ),
                account_identity=str(wallet_snapshot.get("account_identity") or "")
                or None,
                now=stage4_started,
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
                        "active_loss_prevention_gates": stage4_risk_gates,
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
                        "joint_scenario_stress": portfolio["joint_scenario_stress"],
                        "contingent_exit_policies": portfolio["contingent_exit_policies"],
                        "loss_prevention_audit": portfolio["loss_prevention_audit"],
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
                stage4_completed_at = stage_record.completed_at
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

        # Stage 5 — translate only the frozen Stage 4 target.
        stage5_status = "blocked"
        plan: dict[str, object] | None = None
        pending_orders: list[dict[str, object]] = []
        if portfolio is None:
            with SyncSessionLocal() as session:
                run = session.execute(
                    select(Bullpen008RunRecord)
                    .options(selectinload(Bullpen008RunRecord.stages))
                    .where(Bullpen008RunRecord.id == run_id)
                ).scalar_one()
                session.add(
                    _blocked_stage(
                        run,
                        stage_number=5,
                        stage_name="Exit & Rebalance Plan",
                        reason="Stage 4 did not produce a target portfolio.",
                    )
                )
                session.commit()
        else:
            stage5_started = datetime.now(UTC)
            try:
                stage5_wallet = asyncio.run(
                    _refresh_wallet_snapshot(
                        settings, caller_source="bullpen008-stage5-plan"
                    )
                )
                pending_orders = _pending_order_packets(user_id)
                plan = build_action_plan(
                    run_id=run_id,
                    stage4_allocations=list(portfolio["allocations"]),
                    stage4_certificate=dict(portfolio["certificate"]),
                    stage3_rows=list(stage3["rows"]),
                    wallet_snapshot=stage5_wallet,
                    pending_orders=pending_orders,
                    settings=settings,
                    stage4_completed_at=stage4_completed_at,
                    # The forced wallet refresh completes after stage5_started;
                    # certify freshness against the post-refresh clock.
                    now=datetime.now(UTC),
                )
                plan_certificate = dict(plan["plan_certificate"])
                stage5_status = (
                    "finished" if plan_certificate.get("plan_certified") is True else "failed"
                )
                with SyncSessionLocal() as session:
                    run = session.execute(
                        select(Bullpen008RunRecord)
                        .options(selectinload(Bullpen008RunRecord.stages))
                        .where(Bullpen008RunRecord.id == run_id)
                    ).scalar_one()
                    run.wallet_snapshot = stage5_wallet
                    session.add(
                        Bullpen008ActionPlanRecord(
                            id=str(plan["plan_id"]),
                            run_id=run.id,
                            workflow_profile=WORKFLOW_PROFILE,
                            version=1,
                            stage4_certificate_hash=str(plan["stage4_certificate_hash"]),
                            plan_hash=str(plan["plan_hash"]),
                            plan_certified=bool(plan_certificate["plan_certified"]),
                            status=stage5_status,
                            account_identity=str(plan.get("account_identity") or "") or None,
                            wallet_version=str(plan["wallet_version"]),
                            payload=plan,
                            certified_at=datetime.now(UTC)
                            if plan_certificate["plan_certified"]
                            else None,
                        )
                    )
                    session.add(
                        _stage_record(
                            run=run,
                            stage_number=5,
                            stage_name="Exit & Rebalance Plan",
                            started_at=stage5_started,
                            status=stage5_status,
                            pass_condition="A complete immutable plan reproduces the Stage 4 target, keeps cash non-negative, preserves every cap and classifies every wallet position.",
                            inputs={
                                "certified_stage4_target": portfolio["allocations"],
                                "stage4_certificate": portfolio["certificate"],
                                "fresh_wallet_snapshot": stage5_wallet,
                                "open_pending_durable_orders_from_007_and_008": pending_orders,
                                "stage3_cluster_map": stage3["rows"],
                                "settings_and_exit_thresholds": settings.model_dump(mode="json"),
                            },
                            calculations={
                                "Position gap": "target exposure - confirmed current exposure - active pending buys + active pending sells",
                                "action_order": ["claim", "cancel", "sell", "trim", "refresh", "capacity", "buy", "hold"],
                                "stage4_is_sole_portfolio_authority": True,
                                "cash_ledger": plan["cash_ledger"],
                            },
                            outputs={
                                "certified_target": portfolio["allocations"],
                                "claims": plan["claims"],
                                "order_cancellations": plan["order_cancellations"],
                                "full_exits": plan["full_exits"],
                                "trims": plan["trims"],
                                "buys": plan["buys"],
                                "dormant_contingent_exits": plan["dormant_contingent_exits"],
                                "holds": plan["holds"],
                                "blocked_untradeable": plan["blocked_untradeable"],
                                "simulated_final_wallet": plan["simulated_final_wallet"],
                                "cash_ledger": plan["cash_ledger"],
                                "cluster_exposure_before_after": plan["cluster_exposure_before_after"],
                                "plan_certificate": plan_certificate,
                                "plan_hash": plan["plan_hash"],
                                "metrics": plan["metrics"],
                            },
                            rejections=list(plan["blocked_untradeable"]),
                            warnings=[]
                            if stage5_status == "finished"
                            else ["The immutable plan is visible, but its deterministic certificate failed."],
                            block_reason=None
                            if stage5_status == "finished"
                            else "Stage 5 plan certificate failed; Stage 6 is blocked.",
                        )
                    )
                    session.commit()
            except Exception as exc:
                logger.exception("Bullpen 008 Stage 5 failed for %s", run_id)
                stage5_status = "failed"
                with SyncSessionLocal() as session:
                    run = session.execute(
                        select(Bullpen008RunRecord)
                        .options(selectinload(Bullpen008RunRecord.stages))
                        .where(Bullpen008RunRecord.id == run_id)
                    ).scalar_one()
                    session.add(
                        _stage_record(
                            run=run,
                            stage_number=5,
                            stage_name="Exit & Rebalance Plan",
                            started_at=stage5_started,
                            status="failed",
                            pass_condition="A complete immutable and certified action plan is persisted.",
                            inputs={"stage4_certificate": portfolio.get("certificate", {})},
                            calculations={"stage4_is_sole_portfolio_authority": True},
                            outputs={"metrics": {}},
                            rejections=[{"error": str(exc)}],
                            warnings=[],
                            block_reason=str(exc),
                        )
                    )
                    session.commit()

        # Stage 6 — shadow mode performs every fresh pre-submit check and never writes remotely.
        stage6_status = "blocked"
        execution: dict[str, object] = {
            "counters": {},
            "terminal_status": "blocked",
            "terminal_reason": "Stage 5 did not pass.",
            "orders_submitted": 0,
        }
        if stage5_status != "finished" or plan is None or portfolio is None:
            with SyncSessionLocal() as session:
                run = session.execute(
                    select(Bullpen008RunRecord)
                    .options(selectinload(Bullpen008RunRecord.stages))
                    .where(Bullpen008RunRecord.id == run_id)
                ).scalar_one()
                session.add(
                    _blocked_stage(
                        run,
                        stage_number=6,
                        stage_name="Execute & Reconcile",
                        reason="Stage 5 did not persist a valid certified plan.",
                    )
                )
                session.commit()
        else:
            stage6_started = datetime.now(UTC)
            try:
                live_wallet = asyncio.run(
                    _refresh_wallet_snapshot(
                        settings,
                        caller_source=(
                            "bullpen008-stage6-shadow-pre-submit"
                            if settings.execution_mode == "shadow"
                            else "bullpen008-stage6-pre-submit"
                        ),
                    )
                )
                quotes = asyncio.run(_refresh_stage6_quotes(plan))
                stage6_pending_orders = _pending_order_packets(user_id)
                with SyncSessionLocal() as guard_session:
                    phase2_state = guard_session.execute(
                        select(Bullpen008StateRecord).where(
                            Bullpen008StateRecord.user_id == user_id,
                            Bullpen008StateRecord.workflow_profile == WORKFLOW_PROFILE,
                        )
                    ).scalar_one_or_none()
                    emergency_stop = bool(
                        phase2_state
                        and phase2_state.payload.get("emergency_stop", False)
                    )
                execution = preflight_execution_plan(
                    plan=plan,
                    stage4_certificate=dict(portfolio["certificate"]),
                    live_wallet_snapshot=live_wallet,
                    quotes_by_market=quotes,
                    pending_orders=stage6_pending_orders,
                    settings=settings,
                    execution_mode=settings.execution_mode,
                    emergency_stop=emergency_stop,
                )
                if settings.execution_mode == "live" and not emergency_stop:
                    execution = asyncio.run(
                        _execute_live_plan(
                            run_id=run_id,
                            user_id=user_id,
                            plan=plan,
                            stage4_certificate=dict(portfolio["certificate"]),
                            settings=settings,
                        )
                    )
                    live_wallet = asyncio.run(
                        _refresh_wallet_snapshot(
                            settings, caller_source="bullpen008-stage6-final-reconciliation"
                        )
                    )
                terminal_status = str(execution["terminal_status"])
                stage6_status = {
                    "completed": "finished",
                    "partial": "partial",
                    "failed": "failed",
                    "blocked": "blocked",
                    "cancelled": "cancelled",
                }.get(terminal_status, "failed")
                intent_packets, attempt_packets, event_packets = _execution_audit_packets(run_id)
                with SyncSessionLocal() as session:
                    run = session.execute(
                        select(Bullpen008RunRecord)
                        .options(selectinload(Bullpen008RunRecord.stages))
                        .where(Bullpen008RunRecord.id == run_id)
                    ).scalar_one()
                    run.wallet_snapshot = live_wallet
                    session.add(
                        _stage_record(
                            run=run,
                            stage_number=6,
                            stage_name="Execute & Reconcile",
                            started_at=stage6_started,
                            status=stage6_status,
                            pass_condition="Every required action reaches its permitted reconciled terminal state; in shadow mode every pre-submit guard passes and no remote write is permitted.",
                            inputs={
                                "immutable_stage5_plan": plan,
                                "fresh_wallet_snapshot": live_wallet,
                                "fresh_quotes": quotes,
                                "all_pending_007_and_008_orders": stage6_pending_orders,
                                "execution_mode": settings.execution_mode,
                            },
                            calculations={
                                "pre_submit_check_count": 14,
                                "stage4_or_stage5_override_permitted": False,
                                "wallet_version_revalidation": True,
                                "account_wide_runtime_serialization": True,
                            },
                            outputs={
                                **execution,
                                "durable_intents": intent_packets,
                                "attempts": attempt_packets,
                                "order_lifecycle_timeline": event_packets,
                                "remote_evidence": [
                                    row for row in attempt_packets
                                    if row.get("remote_order_id") or row.get("remote_transaction_id")
                                ],
                                "final_wallet": live_wallet,
                                "final_cluster_exposure": plan.get("cluster_exposure_before_after", {}),
                                "metrics": execution["counters"],
                            },
                            rejections=[
                                row for row in execution.get("actions", [])
                                if isinstance(row, dict) and row.get("status") == "Blocked"
                            ],
                            warnings=(
                                ["Production shadow mode is active. Stage 6 performed no remote submission."]
                                if settings.execution_mode == "shadow"
                                else []
                            ),
                            block_reason=None
                            if stage6_status == "finished"
                            else str(execution.get("terminal_reason") or "Stage 6 guard failed."),
                        )
                    )
                    session.commit()
            except Exception as exc:
                logger.exception("Bullpen 008 Stage 6 failed for %s", run_id)
                stage6_status = "failed"
                execution = {
                    "counters": {"planned": sum(len(plan.get(key, [])) for key in ("claims", "order_cancellations", "full_exits", "trims", "buys")), "durable_intents": 0, "submitted": 0, "failed": 1},
                    "terminal_status": "failed",
                    "terminal_reason": "Failed before intent creation.",
                    "error": str(exc),
                }
                with SyncSessionLocal() as session:
                    run = session.execute(
                        select(Bullpen008RunRecord)
                        .options(selectinload(Bullpen008RunRecord.stages))
                        .where(Bullpen008RunRecord.id == run_id)
                    ).scalar_one()
                    session.add(
                        _stage_record(
                            run=run,
                            stage_number=6,
                            stage_name="Execute & Reconcile",
                            started_at=stage6_started,
                            status="failed",
                            pass_condition="Every action reaches its permitted reconciled terminal state.",
                            inputs={"immutable_stage5_plan_hash": plan.get("plan_hash")},
                            calculations={"remote_submission_permitted": False},
                            outputs={**execution, "metrics": execution["counters"]},
                            rejections=[{"error": str(exc)}],
                            warnings=[],
                            block_reason="Failed before intent creation: " + str(exc),
                        )
                    )
                    session.commit()

        with SyncSessionLocal() as session:
            run = session.get(Bullpen008RunRecord, run_id)
            if run is None:
                return "missing-run"
            _persist_loss_prevention_artifacts(
                session,
                run=run,
                stage1=stage1,
                stage2=stage2,
                stage3=stage3,
                portfolio=portfolio,
                plan=plan,
            )
            success = stage6_status == "finished"
            run.status = {
                "finished": "completed",
                "partial": "partial",
                "cancelled": "cancelled",
            }.get(stage6_status, "failed")
            run.completed_at = datetime.now(UTC)
            run.summary = (
                "Bullpen 008 six-stage shadow run completed through certified planning and safe execution validation."
                if success
                else (
                    "Bullpen 008 six-stage run partially reconciled; remaining actions retain exact blockers."
                    if stage6_status == "partial"
                    else "Bullpen 008 six-stage run stopped safely because a stage pass condition or execution guard was not satisfied."
                )
            )
            run.error_message = (
                None
                if success
                else str(execution.get("terminal_reason") or "One or more six-stage pass conditions failed; no remote order was submitted.")
            )
            run.run_metadata = {
                **dict(run.run_metadata),
                "orders_created": int(execution.get("counters", {}).get("durable_intents", 0)) if isinstance(execution.get("counters"), dict) else 0,
                "orders_submitted": int(execution.get("counters", {}).get("submitted", 0)) if isinstance(execution.get("counters"), dict) else 0,
                "stage5_status": stage5_status,
                "stage6_status": stage6_status,
                "execution_mode": settings.execution_mode,
                "final_reconciled_outcome": execution.get("terminal_status"),
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
        return "completed" if stage6_status == "finished" else "failed-safe"
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
            shadow_mode=settings.shadow_mode,
            execution_enabled=settings.execution_enabled,
            started_at=now,
            summary="Bullpen 008 scheduled six-stage shadow-mode run queued.",
            code_build_version=resolve_backend_commit_sha(),
            settings_snapshot=settings.model_dump(mode="json"),
            wallet_snapshot={},
            task_metadata={
                "task_name": CELERY_TASK_NAME,
                "queue": CELERY_QUEUE,
                "workflow_profile": WORKFLOW_PROFILE,
            },
            run_metadata={
                "phase": 2,
                "stages_enabled": [1, 2, 3, 4, 5, 6],
                "execution_mode": settings.execution_mode,
                "orders_permitted": settings.execution_enabled and settings.live_control_armed,
            },
        )
        session.add(run)
        state.next_run_at = next_custom_console_schedule_time(
            now,
            start_at=settings.auto_start_at,
            refresh_minutes=settings.auto_refresh_minutes,
        )
        session.commit()
    execute_bullpen008_run.apply_async(
        args=[run_id], queue=CELERY_QUEUE, task_id=f"bullpen008:{run_id}"
    )
    return run_id


def _continuous_risk_monitor(
    session,
    *,
    user_id: int,
    run: Bullpen008RunRecord,
    settings: Bullpen008Settings,
    refreshed: dict[str, object],
    stage2_rows: list[dict[str, object]],
) -> dict[str, dict[str, object]]:
    """Observe and activate only immutable Stage 4 policies; never invent one."""
    now = datetime.now(UTC)
    wallet_version = stable_hash(
        {
            "account_identity": refreshed.get("account_identity"),
            "fetched_at": refreshed.get("fetched_at"),
            "positions": refreshed.get("positions", []),
        }
    )
    positions = {
        (str(row.get("market_id") or ""), str(row.get("side") or "").upper()): row
        for row in refreshed.get("positions", [])
        if isinstance(row, dict) and row.get("market_id")
    }
    for (market_id, side), position in positions.items():
        odds = position.get("current_yes_odds") if side == "YES" else position.get("current_no_odds")
        if not isinstance(odds, (int, float)):
            continue
        session.add(
            Bullpen008QuoteObservationRecord(
                user_id=user_id,
                market_id=market_id,
                side=side,
                observed_at=now,
                held_side_odds=float(odds),
                wallet_version=wallet_version,
                payload={
                    "source": "continuous_wallet_refresh",
                    "fetched_at": refreshed.get("fetched_at"),
                    "account_identity": refreshed.get("account_identity"),
                },
            )
        )
    session.flush()

    balance = refreshed.get("balance") if isinstance(refreshed.get("balance"), dict) else {}
    cash = float(balance.get("available_balance_usd") or 0)
    liquidation = sum(
        float(row.get("current_value_usd") or row.get("exposure_usd") or 0)
        for row in refreshed.get("positions", [])
        if isinstance(row, dict)
    )
    pending = _pending_order_packets(user_id)
    pending_buy_usd = sum(
        float(
            row.get("remaining_usd")
            or row.get("current_order_usd")
            or row.get("requested_order_usd")
            or 0
        )
        for row in pending
        if str(row.get("action") or row.get("action_type") or "").lower() == "buy"
    )
    equity = cash + liquidation + pending_buy_usd
    baseline = session.execute(
        select(Bullpen008DailyEquityBaselineRecord).where(
            Bullpen008DailyEquityBaselineRecord.user_id == user_id,
            Bullpen008DailyEquityBaselineRecord.baseline_date == now.date().isoformat(),
        )
    ).scalar_one_or_none()
    if baseline is None:
        baseline = Bullpen008DailyEquityBaselineRecord(
            user_id=user_id,
            baseline_date=now.date().isoformat(),
            baseline_at=now,
            wallet_version=wallet_version,
            equity_usd=equity,
            payload={
                "cash_usd": cash,
                "marked_liquidation_value_usd": liquidation,
                "pending_and_unreconciled_usd": pending_buy_usd,
                "external_flows_usd": float(balance.get("net_external_flows_usd") or 0),
                "storage_timezone": "UTC",
                "display_timezone": "Asia/Kolkata",
            },
        )
        session.add(baseline)
        session.flush()
    baseline_external_flows = float(
        dict(baseline.payload or {}).get("external_flows_usd") or 0
    )
    external_flows = (
        float(balance.get("net_external_flows_usd") or 0)
        - baseline_external_flows
    )
    drawdown = evaluate_drawdown(
        baseline_equity_usd=baseline.equity_usd,
        current_equity_usd=equity,
        external_flows_usd=external_flows,
        settings=settings,
    )
    latest_drawdown = session.execute(
        select(Bullpen008DrawdownEpisodeRecord)
        .where(Bullpen008DrawdownEpisodeRecord.user_id == user_id)
        .order_by(Bullpen008DrawdownEpisodeRecord.activated_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    if latest_drawdown is None or latest_drawdown.status != drawdown["state"]:
        if latest_drawdown is not None and latest_drawdown.recovered_at is None:
            latest_drawdown.recovered_at = now
        session.add(
            Bullpen008DrawdownEpisodeRecord(
                user_id=user_id,
                baseline_id=baseline.id,
                status=str(drawdown["state"]),
                activated_at=now,
                payload={
                    **drawdown,
                    "pending_buys_would_cancel": [row for row in pending if drawdown["exit_only"]],
                    "permitted_actions": ["claim", "cancel", "sell", "trim"],
                    "prohibited_actions": ["buy", "top_up", "average_down"] if drawdown["buy_freeze"] else [],
                },
            )
        )

    stage3 = next((stage for stage in run.stages if stage.stage_number == 3), None)
    stage3_rows = (
        list(stage3.outputs_json.get("rows", []))
        if stage3 is not None and isinstance(stage3.outputs_json.get("rows"), list)
        else []
    )
    stage3_by_market = {str(row.get("market_id") or ""): row for row in stage3_rows if isinstance(row, dict)}
    stage2_by_market = {str(row.get("market_id") or ""): row for row in stage2_rows if isinstance(row, dict)}
    regimes: dict[str, dict[str, object]] = {}
    new_regime_episode = False
    for market_id, row in stage2_by_market.items():
        evidence = validate_evidence_packet(
            row.get("evidence_packet"),
            risk_tier=str(row.get("risk_tier") or "standard_objective"),
            settings=settings,
            now=now,
        )
        packet_hash = str(evidence.get("packet_hash") or stable_hash(evidence))
        packet_exists = session.execute(
            select(Bullpen008EvidencePacketRecord.id).where(
                Bullpen008EvidencePacketRecord.run_id == run.id,
                Bullpen008EvidencePacketRecord.market_id == market_id,
                Bullpen008EvidencePacketRecord.packet_hash == packet_hash,
            )
        ).scalar_one_or_none()
        if packet_exists is None:
            session.add(
                Bullpen008EvidencePacketRecord(
                    user_id=user_id,
                    run_id=run.id,
                    market_id=market_id,
                    packet_hash=packet_hash,
                    status="complete" if evidence.get("evidence_complete") else "blocked",
                    fetched_at=now,
                    payload=evidence,
                )
            )
        regime = detect_regime_change(row)
        if not regime["regime_change_active"]:
            continue
        scenarios = list(stage3_by_market.get(market_id, {}).get("joint_loss_scenario_ids") or [])
        for scenario_id in scenarios or [f"market:{market_id}"]:
            episode_hash = str(regime["episode_hash"])
            exists = session.execute(
                select(Bullpen008RegimeChangeEpisodeRecord.id).where(
                    Bullpen008RegimeChangeEpisodeRecord.user_id == user_id,
                    Bullpen008RegimeChangeEpisodeRecord.scenario_id == str(scenario_id),
                    Bullpen008RegimeChangeEpisodeRecord.episode_hash == episode_hash,
                )
            ).scalar_one_or_none()
            if exists is None:
                new_regime_episode = True
                session.add(
                    Bullpen008RegimeChangeEpisodeRecord(
                        user_id=user_id,
                        run_id=run.id,
                        scenario_id=str(scenario_id),
                        episode_hash=episode_hash,
                        status="ACTIVE_BUY_FREEZE",
                        activated_at=now,
                        payload={**regime, "market_id": market_id, "fresh_stage_1_to_4_required": True},
                    )
                )
                session.add(
                    Bullpen008ScenarioCooldownRecord(
                        user_id=user_id,
                        scenario_id=str(scenario_id),
                        status="ACTIVE",
                        starts_at=now,
                        ends_at=now + timedelta(hours=settings.post_shock_cooldown_hours),
                        payload={
                            "reason": "INFORMATION_SHOCK",
                            "opposite_side_auto_buy_prohibited": True,
                            "fresh_stage_1_to_4_after_recovery_required": True,
                        },
                    )
                )
            regimes[market_id] = regime

    policies = session.execute(
        select(Bullpen008ContingentExitPolicyRecord).where(
            Bullpen008ContingentExitPolicyRecord.user_id == user_id,
            Bullpen008ContingentExitPolicyRecord.run_id == run.id,
            Bullpen008ContingentExitPolicyRecord.status == "DORMANT",
        )
    ).scalars().all()
    monitor_by_market: dict[str, dict[str, object]] = {}
    live_activation_action_ids: list[str] = []
    for policy_record in policies:
        policy = dict(policy_record.payload)
        market_id = policy_record.market_id
        position_candidates = [(key, row) for key, row in positions.items() if key[0] == market_id]
        observations = [
            {
                "observed_at": record.observed_at.isoformat(),
                "held_side_odds": record.held_side_odds,
                "wallet_version": record.wallet_version,
            }
            for record in session.execute(
                select(Bullpen008QuoteObservationRecord)
                .where(
                    Bullpen008QuoteObservationRecord.user_id == user_id,
                    Bullpen008QuoteObservationRecord.market_id == market_id,
                    Bullpen008QuoteObservationRecord.observed_at >= now - timedelta(hours=24),
                )
                .order_by(Bullpen008QuoteObservationRecord.observed_at.asc())
            ).scalars()
        ]
        evaluation = evaluate_contingent_policy(
            policy,
            observations,
            now=now,
            regime_change_active=market_id in regimes,
            hard_drawdown_active=bool(drawdown["exit_only"]),
        )
        blockers = list(evaluation["blocker_codes"])
        if not position_candidates:
            blockers.append("HOLDING_NO_LONGER_EXISTS")
        else:
            (_, position) = position_candidates[0]
            live_shares = float(position.get("shares") or 0)
            if float(policy.get("maximum_sell_quantity") or 0) > live_shares + 1e-6:
                blockers.append("CERTIFIED_QUANTITY_EXCEEDS_LIVE_SHARES")
        plan = run.action_plan.payload if run.action_plan is not None else {}
        if str(plan.get("account_identity") or "") != str(refreshed.get("account_identity") or ""):
            blockers.append("ACCOUNT_IDENTITY_MISMATCH")
        action = next(
            (
                row for row in plan.get("dormant_contingent_exits", [])
                if isinstance(row, dict) and row.get("contingent_policy_hash") == policy_record.policy_hash
            ),
            None,
        )
        if action is None:
            blockers.append("IMMUTABLE_STAGE5_ACTION_MISSING")
        fence = None
        if evaluation["trigger_proven"] and not blockers:
            fence = acquire_bullpen_account_execution_advisory_lock_sync(str(refreshed.get("account_identity") or ""))
            if fence is None:
                blockers.append("ACCOUNT_EXECUTION_LOCK_BUSY")
        if fence is not None:
            try:
                if not fence.is_healthy():
                    blockers.append("ACCOUNT_EXECUTION_LOCK_LOST")
            finally:
                fence.release()
        status = "BLOCKED" if blockers else str(evaluation["activation_status"])
        submission = None if blockers else evaluation.get("submission_status")
        episode_hash = stable_hash(
            {
                "policy_hash": policy_record.policy_hash,
                "triggers": evaluation["trigger_types"],
                "first_quote": evaluation["first_quote"],
                "confirming_quote": evaluation["confirming_quote"],
            }
        )
        packet = {
            **evaluation,
            "activation_status": status,
            "submission_status": submission,
            "blocker_codes": list(dict.fromkeys(blockers)),
            "shadow_live_status": settings.execution_mode.upper(),
            "remote_action": {
                "action_type": policy.get("permitted_action"),
                "maximum_sell_quantity": policy.get("maximum_sell_quantity"),
                "minimum_acceptable_price": policy.get("minimum_acceptable_price"),
                "never_market_order": True,
                "affected_scenario_ids": policy.get("affected_scenario_ids", []),
            },
            "drawdown": drawdown,
            "regime_change": regimes.get(market_id),
            "stage5_action_id": action.get("action_id") if action else None,
        }
        if (
            evaluation["trigger_proven"]
            and not blockers
            and action is not None
            and settings.execution_mode == "live"
        ):
            live_activation_action_ids.append(str(action["action_id"]))
        if evaluation["trigger_types"]:
            existing = session.execute(
                select(Bullpen008ContingentExitActivationRecord.id).where(
                    Bullpen008ContingentExitActivationRecord.user_id == user_id,
                    Bullpen008ContingentExitActivationRecord.policy_hash == policy_record.policy_hash,
                    Bullpen008ContingentExitActivationRecord.episode_hash == episode_hash,
                )
            ).scalar_one_or_none()
            if existing is None:
                session.add(
                    Bullpen008ContingentExitActivationRecord(
                        user_id=user_id,
                        run_id=run.id,
                        market_id=market_id,
                        policy_hash=policy_record.policy_hash,
                        episode_hash=episode_hash,
                        status=status,
                        activated_at=now,
                        payload=packet,
                    )
                )
        monitor_by_market[market_id] = packet
    reassessment_run_id: str | None = None
    if new_regime_episode:
        active_run = session.execute(
            select(Bullpen008RunRecord.id).where(
                Bullpen008RunRecord.user_id == user_id,
                Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
                Bullpen008RunRecord.status.in_(["queued", "running"]),
            ).limit(1)
        ).scalar_one_or_none()
        if active_run is None:
            safe_settings = settings.model_copy(
                update={
                    "shadow_mode": True,
                    "execution_enabled": False,
                    "execution_mode": "shadow",
                    "live_control_armed": False,
                }
            )
            reassessment_run_id = f"b008-{uuid4().hex}"
            session.add(
                Bullpen008RunRecord(
                    id=reassessment_run_id,
                    user_id=user_id,
                    workflow_profile=WORKFLOW_PROFILE,
                    idempotency_key=f"bullpen008:risk-monitor:{stable_hash(regimes)}",
                    status="queued",
                    triggered_by="risk-monitor",
                    shadow_mode=True,
                    execution_enabled=False,
                    started_at=now,
                    summary="Bullpen 008 regime-change shadow reassessment queued.",
                    code_build_version=resolve_backend_commit_sha(),
                    settings_snapshot=safe_settings.model_dump(mode="json"),
                    wallet_snapshot=refreshed,
                    task_metadata={
                        "task_name": CELERY_TASK_NAME,
                        "queue": CELERY_QUEUE,
                        "workflow_profile": WORKFLOW_PROFILE,
                    },
                    run_metadata={
                        "phase": "p0-loss-prevention",
                        "trigger": "VERIFIED_REGIME_CHANGE",
                        "orders_permitted": False,
                    },
                )
            )
    monitor_by_market["__meta__"] = {
        "reassessment_run_id": reassessment_run_id,
        "new_regime_episode": new_regime_episode,
        "live_activation_action_ids": live_activation_action_ids,
    }
    return monitor_by_market


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


@celery.task(name="app.domains.bullpen008.tasks.refresh_bullpen008_position_alerts")
def refresh_bullpen008_position_alerts() -> int:
    """Refresh actual held-side odds independently of six-stage run completion."""
    from app.domains.bullpen008.alerts import evaluate_held_position_alerts
    from app.domains.mails.service import TEST_RECIPIENTS, send_logged_email_sync

    with SyncSessionLocal() as session:
        user_ids = session.execute(
            select(Bullpen008SettingsRecord.user_id).where(
                Bullpen008SettingsRecord.workflow_profile == WORKFLOW_PROFILE
            )
        ).scalars().all()
    created = 0
    for user_id in user_ids:
        with SyncSessionLocal() as session:
            settings_record = session.execute(
                select(Bullpen008SettingsRecord).where(
                    Bullpen008SettingsRecord.user_id == user_id,
                    Bullpen008SettingsRecord.workflow_profile == WORKFLOW_PROFILE,
                )
            ).scalar_one()
            phase2_settings = Bullpen008Settings.model_validate(settings_record.payload)
            run = session.execute(
                select(Bullpen008RunRecord)
                .options(
                    selectinload(Bullpen008RunRecord.stages),
                    selectinload(Bullpen008RunRecord.action_plan),
                    selectinload(Bullpen008RunRecord.certificate),
                )
                .where(
                    Bullpen008RunRecord.user_id == user_id,
                    Bullpen008RunRecord.workflow_profile == WORKFLOW_PROFILE,
                )
                .order_by(Bullpen008RunRecord.started_at.desc())
                .limit(1)
            ).scalar_one_or_none()
            if run is None:
                continue
            stage2 = next((stage for stage in run.stages if stage.stage_number == 2), None)
            stage2_rows = (
                list(stage2.outputs_json.get("rows", []))
                if stage2 is not None and isinstance(stage2.outputs_json.get("rows"), list)
                else []
            )
            history = session.execute(
                select(Bullpen008AlertRecord)
                .where(
                    Bullpen008AlertRecord.user_id == user_id,
                    Bullpen008AlertRecord.workflow_profile == WORKFLOW_PROFILE,
                )
                .order_by(Bullpen008AlertRecord.created_at.asc())
            ).scalars().all()
            active = {
                (record.market_id, record.side)
                for record in history
                if record.recovered_at is None
            }
            versions: dict[tuple[str, str], int] = defaultdict(int)
            for record in history:
                versions[(record.market_id, record.side)] += 1
        try:
            refreshed = asyncio.run(
                _refresh_wallet_snapshot(
                    phase2_settings,
                    caller_source="bullpen008-continuous-alert-refresh",
                )
            )
        except Exception:
            logger.exception("Bullpen 008 continuous alert wallet refresh failed for user %s", user_id)
            continue
        stage2_rows = _attach_high_shock_evidence(
            stage2_rows, now=datetime.now(UTC), force_refresh=True
        )
        evaluation = evaluate_held_position_alerts(
            positions=list(refreshed.get("positions", [])),
            stage2_rows=stage2_rows,
            active_episodes=active,
            episode_versions=versions,
            threshold=phase2_settings.entry_side_odds_floor_pct,
        )
        reassessment_run_id: str | None = None
        live_activation_action_ids: set[str] = set()
        with SyncSessionLocal() as session:
            monitor_by_market = _continuous_risk_monitor(
                session,
                user_id=user_id,
                run=run,
                settings=phase2_settings,
                refreshed=refreshed,
                stage2_rows=stage2_rows,
            )
            monitor_meta = monitor_by_market.get("__meta__", {})
            reassessment_run_id = str(monitor_meta.get("reassessment_run_id") or "") or None
            live_activation_action_ids = {
                str(value)
                for value in monitor_meta.get("live_activation_action_ids", [])
                if value
            }
            for recovery in evaluation["recoveries"]:
                record = session.execute(
                    select(Bullpen008AlertRecord)
                    .where(
                        Bullpen008AlertRecord.user_id == user_id,
                        Bullpen008AlertRecord.workflow_profile == WORKFLOW_PROFILE,
                        Bullpen008AlertRecord.market_id == recovery["market_id"],
                        Bullpen008AlertRecord.side == recovery["side"],
                        Bullpen008AlertRecord.recovered_at.is_(None),
                    )
                    .order_by(Bullpen008AlertRecord.created_at.desc())
                    .limit(1)
                ).scalar_one_or_none()
                if record is not None:
                    record.recovered_at = datetime.now(UTC)
                    record.payload = {**dict(record.payload), "recovery": recovery}
            for alert in evaluation["alerts"]:
                monitor = monitor_by_market.get(str(alert["market_id"]), {})
                record = Bullpen008AlertRecord(
                    user_id=user_id,
                    workflow_profile=WORKFLOW_PROFILE,
                    market_id=str(alert["market_id"]),
                    side=str(alert["side"]),
                    source="continuous_wallet_refresh",
                    breach_type=str(alert["breach_type"]),
                    idempotency_key=str(alert["idempotency_key"]),
                    llm_odds=alert.get("llm_odds"),
                    actual_odds=alert.get("actual_odds"),
                    payload={
                        **alert,
                        "run_id": run.id,
                        "refresh_fetched_at": refreshed.get("fetched_at"),
                        "risk_monitor": monitor,
                    },
                )
                session.add(record)
                session.flush()
                breach_label = {
                    "llm": "LLM odds",
                    "actual": "Actual Current Bullpen Odds",
                    "both": "LLM odds and Actual Current Bullpen Odds",
                }[str(alert["breach_type"])]
                text_content = (
                    f"WARNING — Bullpen 008 held position below {alert['threshold']}%\n\n"
                    f"{alert['question']}\nHeld side: {alert['side']}\n"
                    f"LLM odds: {alert.get('llm_odds')}\nActual Bullpen odds: {alert.get('actual_odds')}\n"
                    f"Alert triggered by: {breach_label}\n"
                    f"Contingent trigger: {', '.join(monitor.get('trigger_types', [])) or 'none'}\n"
                    f"First quote: {monitor.get('first_quote')}\nConfirming quote: {monitor.get('confirming_quote')}\n"
                    f"15-minute decline: {monitor.get('drop_15m_pp')} pp\n24-hour decline: {monitor.get('drop_24h_pp')} pp\n"
                    f"Evidence/regime status: {monitor.get('regime_change') or 'no active verified episode'}\n"
                    f"Scenario: {monitor.get('remote_action', {}).get('affected_scenario_ids', 'see certified policy')}\n"
                    f"Shadow/live status: {monitor.get('shadow_live_status', phase2_settings.execution_mode.upper())}\n"
                    f"Action status: {monitor.get('activation_status', 'DORMANT')} / {monitor.get('submission_status')}\n"
                    f"Blocker or recovery state: {', '.join(monitor.get('blocker_codes', [])) or 'none'}\n\n"
                    "Email delivery is not proof that an exit executed."
                )
                scenario = monitor.get("remote_action", {}).get(
                    "affected_scenario_ids", "see certified policy"
                )
                trigger_types = (
                    ", ".join(monitor.get("trigger_types", [])) or "none"
                )
                blocker_state = (
                    ", ".join(monitor.get("blocker_codes", [])) or "none"
                )
                regime_status = (
                    monitor.get("regime_change") or "no active verified episode"
                )
                shadow_status = monitor.get(
                    "shadow_live_status", phase2_settings.execution_mode.upper()
                )
                action_status = (
                    f"{monitor.get('activation_status', 'DORMANT')} / "
                    f"{monitor.get('submission_status')}"
                )
                safe = lambda value: html.escape(str(value))
                html_content = (
                    '<div style="font-family:Arial,Helvetica,sans-serif;'
                    'font-size:16px;line-height:1.55;color:#f5f5f5;'
                    'background:#111;padding:24px">'
                    '<h2 style="margin:0 0 24px;color:#ff8f7a;'
                    'font-size:28px;line-height:1.2">'
                    "WARNING — Active position exit required</h2>"
                    "<p>Continuous Bullpen 008 monitoring found that the held-side "
                    "LLM odds, actual current held-side Bullpen odds, or both are "
                    f"below {safe(alert['threshold'])}%.</p>"
                    '<ol style="padding-left:28px"><li style="margin-bottom:20px">'
                    f'<p><strong>{safe(alert["question"])}</strong></p>'
                    f'<p>Held side: <strong>{safe(alert["side"])}</strong></p>'
                    "<p>Consolidated held-side LLM odds: "
                    f'<strong>{safe(alert.get("llm_odds"))}%</strong></p>'
                    "<p>Actual current held-side Bullpen odds: "
                    f'<strong>{safe(alert.get("actual_odds"))}%</strong></p>'
                    f"<p>Alert triggered by: <strong>{safe(breach_label)}</strong></p>"
                    "<p>Action: <strong>EXIT this position as soon as practical.</strong></p>"
                    "</li></ol>"
                    '<hr style="border:0;border-top:1px solid #444;margin:24px 0">'
                    f"<p><strong>Contingent trigger:</strong> {safe(trigger_types)}<br>"
                    f"<strong>First quote:</strong> {safe(monitor.get('first_quote'))}<br>"
                    f"<strong>Confirming quote:</strong> {safe(monitor.get('confirming_quote'))}<br>"
                    f"<strong>15-minute decline:</strong> {safe(monitor.get('drop_15m_pp'))} pp<br>"
                    f"<strong>24-hour decline:</strong> {safe(monitor.get('drop_24h_pp'))} pp<br>"
                    f"<strong>Evidence/regime status:</strong> {safe(regime_status)}<br>"
                    f"<strong>Scenario:</strong> {safe(scenario)}<br>"
                    f"<strong>Shadow/live status:</strong> {safe(shadow_status)}<br>"
                    f"<strong>Action status:</strong> {safe(action_status)}<br>"
                    f"<strong>Blocker or recovery state:</strong> {safe(blocker_state)}</p>"
                    '<p style="margin-top:24px;color:#ffb4a8"><strong>'
                    "Email delivery is not proof that an exit executed."
                    "</strong></p></div>"
                )
                delivery = send_logged_email_sync(
                    session,
                    user_id=user_id,
                    action="mail.bullpen008_position_warning",
                    trigger=f"Bullpen 008 {breach_label}",
                    recipients=TEST_RECIPIENTS,
                    subject=f"WARNING: Bullpen 008 held {alert['side']} odds below {alert['threshold']}%",
                    html_content=html_content,
                    text_content=text_content,
                    remarks="Bullpen 008 alert only; no order was created.",
                    idempotency_key=str(alert["idempotency_key"]),
                    run_id=run.id,
                    warnings=[alert],
                )
                record.payload = {**dict(record.payload), "mail_history_id": delivery.history_id, "mail_deduplicated": delivery.deduplicated}
                created += 1
            session.commit()
        if reassessment_run_id is not None:
            execute_bullpen008_run.apply_async(
                args=[reassessment_run_id],
                queue=CELERY_QUEUE,
                task_id=f"bullpen008:{reassessment_run_id}",
            )
        if live_activation_action_ids:
            try:
                if run.action_plan is None or run.certificate is None:
                    raise RuntimeError("IMMUTABLE_PLAN_OR_CERTIFICATE_MISSING")
                live_result = asyncio.run(
                    _execute_live_plan(
                        run_id=run.id,
                        user_id=user_id,
                        plan=dict(run.action_plan.payload),
                        stage4_certificate=dict(run.certificate.payload),
                        settings=phase2_settings,
                        activated_contingent_action_ids=live_activation_action_ids,
                    )
                )
                result_by_action = {
                    str(row.get("action_id") or ""): row
                    for row in live_result.get("actions", [])
                    if isinstance(row, dict)
                }
            except Exception as exc:
                logger.exception("Bullpen 008 contingent live activation failed safely")
                result_by_action = {
                    action_id: {
                        "action_id": action_id,
                        "status": "Blocked",
                        "blocker_code": str(exc),
                    }
                    for action_id in live_activation_action_ids
                }
            with SyncSessionLocal() as session:
                activations = session.execute(
                    select(Bullpen008ContingentExitActivationRecord).where(
                        Bullpen008ContingentExitActivationRecord.user_id == user_id,
                        Bullpen008ContingentExitActivationRecord.run_id == run.id,
                    )
                ).scalars().all()
                for activation in activations:
                    action_id = str(activation.payload.get("stage5_action_id") or "")
                    live_row = result_by_action.get(action_id)
                    if live_row is None:
                        continue
                    activation.status = str(live_row.get("status") or "Recoverable")
                    activation.payload = {
                        **dict(activation.payload),
                        "live_execution_result": live_row,
                    }
                session.commit()
    return created


@celery.task(name="app.domains.bullpen008.tasks.recover_bullpen008_executions")
def recover_bullpen008_executions() -> int:
    """Reconcile remote-identified 008 intents; never resubmit an ambiguous one."""
    with SyncSessionLocal() as session:
        records = session.execute(
            select(Bullpen008ExecutionIntentRecord).where(
                Bullpen008ExecutionIntentRecord.workflow_profile == WORKFLOW_PROFILE,
                Bullpen008ExecutionIntentRecord.status.in_(
                    ("Submitted", "Confirming", "PartiallyFilled", "Recoverable")
                ),
                Bullpen008ExecutionIntentRecord.remote_order_id.is_not(None),
            )
        ).scalars().all()
        intent_ids = [record.id for record in records]
    adapter = ProductionBullpen008Adapter()
    reconciled_count = 0
    for intent_id in intent_ids:
        with SyncSessionLocal() as session:
            record = session.get(Bullpen008ExecutionIntentRecord, intent_id)
            if record is None or not record.remote_order_id:
                continue
            request = record.payload.get("sanitized_request")
            action = request.get("action") if isinstance(request, dict) else None
            if not isinstance(action, dict):
                record.blocker_code = "RECOVERY_ACTION_PAYLOAD_MISSING"
                record.status = "Recoverable"
                session.commit()
                continue
            remote_id = record.remote_order_id
        try:
            evidence = asyncio.run(adapter.reconcile(remote_id=remote_id, action=action))
        except Exception as exc:
            logger.warning("Bullpen 008 recovery could not reconcile intent %s: %s", intent_id, exc)
            continue
        with SyncSessionLocal() as session:
            record = session.get(Bullpen008ExecutionIntentRecord, intent_id)
            if record is None:
                continue
            previous = record.status
            status = str(evidence.get("status") or "Recoverable")
            record.status = status
            record.filled_shares = float(evidence.get("filled_shares") or record.filled_shares)
            record.filled_value_usd = float(evidence.get("filled_value_usd") or record.filled_value_usd)
            record.average_price_cents = evidence.get("average_price_cents") or record.average_price_cents
            record.fees_usd = evidence.get("fees_usd") or record.fees_usd
            record.payload = {**dict(record.payload), "recovery_evidence": evidence}
            if status == "Reconciled":
                record.reconciled_at = datetime.now(UTC)
                record.terminal_at = record.reconciled_at
            session.add(
                Bullpen008ExecutionEventRecord(
                    intent_id=record.id,
                    workflow_profile=WORKFLOW_PROFILE,
                    from_status=previous,
                    to_status=status,
                    reason_code="RECOVERY_BY_REMOTE_ID",
                    evidence=evidence,
                    occurred_at=datetime.now(UTC),
                )
            )
            session.commit()
            reconciled_count += 1
    return reconciled_count
