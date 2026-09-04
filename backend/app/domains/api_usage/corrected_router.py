from __future__ import annotations

from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.api_usage.router import (
    API_USAGE_TZ,
    LLM_PROVIDER_LABELS,
    _convert_usd_to_inr,
    _usage_day_string,
    _window_utc,
    api_usage_summary as legacy_api_usage_summary,
    llm_cost_history as legacy_llm_cost_history,
)
from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.api_usage.models import (
    LlmProviderUsageCallRecord,
    LlmProviderUsageDailySnapshot,
)
from app.domains.bullpen_run_audit.models import (
    BullpenRunAuditFeedbackRecord,
    BullpenRunAuditFeedbackSubcallRecord,
)
from app.domains.fx_rates.service import load_persisted_usd_inr_rate
from app.domains.jobs.models import Job
from app.infrastructure.database.session import get_async_db

router = APIRouter(prefix="/api-usage", tags=["api-usage"])

PROVIDER_LEDGER_COMPLETE_FROM_DATE = date(2026, 9, 5)


def _safe_int(value: object, default: int = 0) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return default


def _job_request_count(job: Job) -> int:
    """Return the closest persisted count of outbound provider requests.

    Bullpen Stage 2 jobs persist one runtime row per batch, including retries and
    recovery batches. Older and non-Bullpen jobs do not persist every internal
    provider round, so web-search rounds are used as a conservative lower bound.
    """
    metadata = (
        job.runtime_metadata_json
        if isinstance(job.runtime_metadata_json, dict)
        else {}
    )
    batches = metadata.get("llm_batches")
    if isinstance(batches, list):
        batch_attempts = sum(
            max(1, _safe_int(batch.get("attempts"), 1))
            for batch in batches
            if isinstance(batch, dict)
        )
        if batch_attempts:
            return batch_attempts

    request_counter_keys = (
        "llm_primary_request_count",
        "llm_retry_request_count",
        "llm_recovery_batch_count",
    )
    if any(key in metadata for key in request_counter_keys):
        return max(
            1,
            _safe_int(metadata.get("llm_primary_request_count"))
            + _safe_int(metadata.get("llm_retry_request_count"))
            + _safe_int(metadata.get("llm_recovery_batch_count")),
        )

    queries = job.web_search_queries if isinstance(job.web_search_queries, list) else []
    unique_queries = {str(query).strip() for query in queries if str(query).strip()}
    return max(1, 1 + len(unique_queries))


def _classify_job_usage(job: Job) -> tuple[str, str, str]:
    """Map a persisted LLM job to the Cred-X workflow that consumed it."""
    context = (
        job.request_context_json if isinstance(job.request_context_json, dict) else {}
    )
    kind = str(context.get("kind") or "").strip().lower()
    prompt = (job.prompt or "").upper()
    portfolio = str(job.auto_rebalance_portfolio or "").strip().lower()

    if kind == "polymarket_bullpen_event" or "BULLPEN" in kind:
        return "bullpen", "Bullpen", "Bullpen Stage 2 event analysis"
    if portfolio == "india" or "[ZERODHA_" in prompt:
        workflow = "Zerodha event/threat/rebalance analysis"
        return "zerodha", "Zerodha", workflow
    if portfolio == "indmoney_us" or "[INDMONEY_US_" in prompt:
        workflow = "INDmoney US event/threat/rebalance analysis"
        return "indmoney", "INDmoney US", workflow
    if "[STAGE2_SHARED_EVIDENCE_ONLY]" in prompt and "POLYMARKET" in prompt:
        return "bullpen", "Bullpen", "Bullpen evidence-grounded analysis"
    return "other", "Other Cred-X", "Other LLM job"


def _new_usage_row(
    *,
    provider: str,
    model: str,
    source_key: str,
    source_label: str,
    workflow: str,
    requests: int,
    tokens_in: int,
    tokens_out: int,
    estimated_cost: float,
    occurred_at: datetime,
    record_kind: str,
    record_id: int,
) -> dict[str, Any]:
    return {
        "provider": provider.strip().lower(),
        "provider_name": LLM_PROVIDER_LABELS.get(
            provider.strip().lower(), provider.strip().title()
        ),
        "model": model,
        "source": source_key,
        "source_label": source_label,
        "workflow": workflow,
        "requests": max(0, int(requests)),
        "tokens_in": max(0, int(tokens_in)),
        "tokens_out": max(0, int(tokens_out)),
        "estimated_cost": max(0.0, float(estimated_cost)),
        "occurred_at": occurred_at,
        "record_kind": record_kind,
        "record_id": int(record_id),
    }


async def _load_usage_rows(
    db: AsyncSession,
    *,
    user_id: int,
    start_utc: datetime,
    end_utc: datetime,
) -> list[dict[str, Any]]:
    jobs = (
        await db.execute(
            select(Job)
            .where(
                Job.user_id == user_id,
                Job.created_at >= start_utc,
                Job.created_at < end_utc,
            )
            .order_by(Job.created_at.asc(), Job.id.asc())
        )
    ).scalars().all()

    rows: list[dict[str, Any]] = []
    for job in jobs:
        source_key, source_label, workflow = _classify_job_usage(job)
        rows.append(
            _new_usage_row(
                provider=job.provider,
                model=job.model,
                source_key=source_key,
                source_label=source_label,
                workflow=workflow,
                requests=_job_request_count(job),
                tokens_in=int(job.tokens_in or 0),
                tokens_out=int(job.tokens_out or 0),
                estimated_cost=float(job.estimated_cost or 0.0),
                occurred_at=job.created_at,
                record_kind="job",
                record_id=job.id,
            )
        )

    audit_subcalls = (
        await db.execute(
            select(BullpenRunAuditFeedbackSubcallRecord)
            .join(
                BullpenRunAuditFeedbackRecord,
                BullpenRunAuditFeedbackRecord.id
                == BullpenRunAuditFeedbackSubcallRecord.feedback_id,
            )
            .where(
                BullpenRunAuditFeedbackRecord.user_id == user_id,
                BullpenRunAuditFeedbackSubcallRecord.created_at >= start_utc,
                BullpenRunAuditFeedbackSubcallRecord.created_at < end_utc,
            )
            .order_by(
                BullpenRunAuditFeedbackSubcallRecord.created_at.asc(),
                BullpenRunAuditFeedbackSubcallRecord.id.asc(),
            )
        )
    ).scalars().all()

    for subcall in audit_subcalls:
        rows.append(
            _new_usage_row(
                provider=subcall.provider,
                model=subcall.model,
                source_key="bullpen",
                source_label="Bullpen",
                workflow="Bullpen run-audit feedback",
                requests=1,
                tokens_in=int(subcall.tokens_in or 0),
                tokens_out=int(subcall.tokens_out or 0),
                estimated_cost=float(subcall.estimated_cost or 0.0),
                occurred_at=subcall.created_at,
                record_kind="bullpen_run_audit_subcall",
                record_id=subcall.id,
            )
        )

    return rows


async def _load_provider_call_rows(
    db: AsyncSession,
    *,
    user_id: int,
    start_utc: datetime,
    end_utc: datetime,
) -> list[dict[str, Any]]:
    start_aware = start_utc.replace(tzinfo=UTC)
    end_aware = end_utc.replace(tzinfo=UTC)
    records = (
        await db.execute(
            select(LlmProviderUsageCallRecord)
            .where(
                LlmProviderUsageCallRecord.user_id == user_id,
                LlmProviderUsageCallRecord.occurred_at >= start_aware,
                LlmProviderUsageCallRecord.occurred_at < end_aware,
            )
            .order_by(
                LlmProviderUsageCallRecord.occurred_at.asc(),
                LlmProviderUsageCallRecord.id.asc(),
            )
        )
    ).scalars().all()
    return [
        _new_usage_row(
            provider=record.provider,
            model=record.model,
            source_key="provider_ledger",
            source_label=f"{LLM_PROVIDER_LABELS.get(record.provider, record.provider.title())} ledger",
            workflow="Durably recorded provider response",
            requests=1,
            tokens_in=int(record.tokens_in),
            tokens_out=int(record.tokens_out),
            estimated_cost=float(record.actual_cost),
            occurred_at=record.occurred_at,
            record_kind="provider_usage_call",
            record_id=record.id,
        )
        for record in records
    ]


async def _load_provider_snapshot_rows(
    db: AsyncSession,
    *,
    user_id: int,
    start_day: date,
    end_day: date,
) -> list[dict[str, Any]]:
    snapshots = (
        await db.execute(
            select(LlmProviderUsageDailySnapshot)
            .where(
                LlmProviderUsageDailySnapshot.user_id == user_id,
                LlmProviderUsageDailySnapshot.timezone == str(API_USAGE_TZ),
                LlmProviderUsageDailySnapshot.usage_date >= start_day,
                LlmProviderUsageDailySnapshot.usage_date <= end_day,
            )
            .order_by(
                LlmProviderUsageDailySnapshot.usage_date.asc(),
                LlmProviderUsageDailySnapshot.id.asc(),
            )
        )
    ).scalars().all()
    rows: list[dict[str, Any]] = []
    for snapshot in snapshots:
        occurred_at = datetime.combine(
            snapshot.usage_date,
            time(hour=12),
            tzinfo=API_USAGE_TZ,
        ).astimezone(UTC)
        row = _new_usage_row(
            provider=snapshot.provider,
            model=snapshot.model,
            source_key="provider_snapshot",
            source_label=f"{LLM_PROVIDER_LABELS.get(snapshot.provider, snapshot.provider.title())} provider ledger",
            workflow="Authoritative daily provider total",
            requests=snapshot.requests,
            tokens_in=snapshot.tokens_in,
            tokens_out=snapshot.tokens_out,
            estimated_cost=snapshot.actual_cost,
            occurred_at=occurred_at,
            record_kind="provider_usage_daily_snapshot",
            record_id=snapshot.id,
        )
        row["measurement"] = "actual"
        row["cache_hit_tokens"] = int(snapshot.cache_hit_tokens)
        row["cache_miss_tokens"] = int(snapshot.cache_miss_tokens)
        row["source_note"] = snapshot.source
        rows.append(row)
    return rows


def _effective_usage_rows(
    local_rows: list[dict[str, Any]],
    call_rows: list[dict[str, Any]],
    snapshot_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Choose one source of truth for every provider calendar day."""

    def bucket(rows: list[dict[str, Any]]) -> dict[tuple[str, str], list[dict[str, Any]]]:
        grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            grouped[(str(row["provider"]), _usage_day_string(row["occurred_at"]))].append(row)
        return grouped

    local_by_day = bucket(local_rows)
    calls_by_day = bucket(call_rows)
    snapshots_by_day = bucket(snapshot_rows)
    keys = set(local_by_day) | set(calls_by_day) | set(snapshots_by_day)
    effective: list[dict[str, Any]] = []
    for key in sorted(keys):
        if key in snapshots_by_day:
            effective.extend(snapshots_by_day[key])
            continue
        usage_day = date.fromisoformat(key[1])
        if usage_day >= PROVIDER_LEDGER_COMPLETE_FROM_DATE and key in calls_by_day:
            for row in calls_by_day[key]:
                row["measurement"] = "actual"
            effective.extend(calls_by_day[key])
            continue
        for row in local_by_day.get(key, []):
            row["measurement"] = "estimated"
        effective.extend(local_by_day.get(key, []))
    return effective


async def _load_effective_usage_rows(
    db: AsyncSession,
    *,
    user_id: int,
    start_utc: datetime,
    end_utc: datetime,
) -> list[dict[str, Any]]:
    local_rows = await _load_usage_rows(
        db, user_id=user_id, start_utc=start_utc, end_utc=end_utc
    )
    call_rows = await _load_provider_call_rows(
        db, user_id=user_id, start_utc=start_utc, end_utc=end_utc
    )
    start_day = start_utc.replace(tzinfo=UTC).astimezone(API_USAGE_TZ).date()
    end_day = (
        (end_utc - timedelta(microseconds=1))
        .replace(tzinfo=UTC)
        .astimezone(API_USAGE_TZ)
        .date()
    )
    snapshot_rows = await _load_provider_snapshot_rows(
        db, user_id=user_id, start_day=start_day, end_day=end_day
    )
    return _effective_usage_rows(local_rows, call_rows, snapshot_rows)


def _aggregate_usage(
    rows: list[dict[str, Any]],
    *,
    usd_inr_rate: float | None,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    grouped: dict[
        tuple[str, str, str, str, str],
        dict[str, Any],
    ] = {}
    provider_totals: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "requests": 0,
            "tokens_in": 0,
            "tokens_out": 0,
            "cost": 0.0,
            "measurement": "estimated",
        }
    )

    for row in rows:
        provider = str(row["provider"])
        provider_total = provider_totals[provider]
        provider_total["requests"] = int(provider_total["requests"]) + int(
            row["requests"]
        )
        provider_total["tokens_in"] = int(provider_total["tokens_in"]) + int(
            row["tokens_in"]
        )
        provider_total["tokens_out"] = int(provider_total["tokens_out"]) + int(
            row["tokens_out"]
        )
        provider_total["cost"] = float(provider_total["cost"]) + float(
            row["estimated_cost"]
        )
        if row.get("measurement") == "actual":
            provider_total["measurement"] = "actual"

        key = (
            provider,
            str(row["model"]),
            str(row["source"]),
            str(row["source_label"]),
            str(row["workflow"]),
        )
        item = grouped.setdefault(
            key,
            {
                "provider": provider,
                "provider_name": row["provider_name"],
                "model": row["model"],
                "source": row["source"],
                "source_label": row["source_label"],
                "workflow": row["workflow"],
                "requests": 0,
                "tokens_in": 0,
                "tokens_out": 0,
                "estimated_cost": 0.0,
                "measurement": row.get("measurement", "estimated"),
                "cache_hit_tokens": 0,
                "cache_miss_tokens": 0,
                "source_note": row.get("source_note"),
            },
        )
        item["requests"] += int(row["requests"])
        item["tokens_in"] += int(row["tokens_in"])
        item["tokens_out"] += int(row["tokens_out"])
        item["estimated_cost"] += float(row["estimated_cost"])
        item["cache_hit_tokens"] += int(row.get("cache_hit_tokens", 0))
        item["cache_miss_tokens"] += int(row.get("cache_miss_tokens", 0))

    items: list[dict[str, Any]] = []
    for item in grouped.values():
        cost = round(float(item["estimated_cost"]), 6)
        item["estimated_cost"] = cost
        item["estimated_cost_inr"] = _convert_usd_to_inr(cost, usd_inr_rate)
        if int(item["tokens_in"]) > 0 or int(item["tokens_out"]) > 0 or cost > 0:
            items.append(item)

    items.sort(
        key=lambda item: (
            str(item["provider_name"]).lower(),
            str(item["model"]).lower(),
            str(item["source_label"]).lower(),
            str(item["workflow"]).lower(),
        )
    )
    for totals in provider_totals.values():
        totals["cost"] = round(float(totals["cost"]), 6)
    return items, dict(provider_totals)


def _patch_summary_llm_items(
    summary: dict[str, Any],
    provider_totals: dict[str, dict[str, Any]],
) -> None:
    usd_inr_rate = summary.get("usd_inr_rate")
    if not isinstance(usd_inr_rate, (int, float)):
        usd_inr_rate = None

    provider_by_label = {
        "OpenAI": "openai",
        "Anthropic": "anthropic",
        "DeepSeek": "deepseek",
    }
    gemini_applied = False
    for item in summary.get("items", []):
        if item.get("category") != "LLM":
            continue
        provider: str | None = provider_by_label.get(str(item.get("name")))
        if item.get("gemini_key_index"):
            provider = "gemini"
            should_receive_usage = (
                bool(item.get("gemini_key_in_use")) and not gemini_applied
            )
            if should_receive_usage:
                gemini_applied = True
            else:
                item["daily_requests"] = 0
                item["daily_tokens_in"] = 0
                item["daily_tokens_out"] = 0
                item["daily_estimated_cost"] = 0.0
                item["daily_estimated_cost_inr"] = _convert_usd_to_inr(
                    0.0, usd_inr_rate
                )
                continue
        if provider is None:
            continue

        totals = provider_totals.get(
            provider,
            {
                "requests": 0,
                "tokens_in": 0,
                "tokens_out": 0,
                "cost": 0.0,
                "measurement": "estimated",
            },
        )
        cost = round(float(totals["cost"]), 6)
        item["daily_requests"] = int(totals["requests"])
        item["daily_tokens_in"] = int(totals["tokens_in"])
        item["daily_tokens_out"] = int(totals["tokens_out"])
        item["daily_estimated_cost"] = cost
        item["daily_estimated_cost_inr"] = _convert_usd_to_inr(cost, usd_inr_rate)
        item["usage_measurement"] = totals.get("measurement", "estimated")
        existing_note = str(item.get("notes") or "").strip()
        accuracy_note = (
            "Actual provider-ledger requests, tokens and cost."
            if totals.get("measurement") == "actual"
            else (
                "Estimated from persisted Cred-X jobs; provider-ledger data is not "
                "available for this day."
            )
        )
        item["notes"] = (
            f"{existing_note} {accuracy_note}".strip()
            if accuracy_note not in existing_note
            else existing_note
        )


@router.get("/summary")
async def corrected_api_usage_summary(
    period: str = Query(default="today"),
    custom_start: date | None = Query(default=None),
    custom_end: date | None = Query(default=None),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    summary = await legacy_api_usage_summary(
        period=period,
        custom_start=custom_start,
        custom_end=custom_end,
        db=db,
        current_user=current_user,
    )
    start_utc, end_utc, _ = _window_utc(period, custom_start, custom_end)
    rows = await _load_effective_usage_rows(
        db,
        user_id=current_user.id,
        start_utc=start_utc,
        end_utc=end_utc,
    )
    _, provider_totals = _aggregate_usage(
        rows,
        usd_inr_rate=summary.get("usd_inr_rate"),
    )
    _patch_summary_llm_items(summary, provider_totals)
    summary["llm_usage_reconciliation"] = {
        "request_metric": "outbound_provider_calls",
        "bullpen_batch_requests_expanded": True,
        "bullpen_run_audit_subcalls_included": True,
        "provider_ledger_preferred": True,
        "historical_limit": (
            "Older non-Bullpen jobs may only retain a lower-bound request count "
            "when the provider adapter performed internal tool or repair rounds."
        ),
    }
    return summary


@router.get("/llms/breakdown")
async def llm_usage_breakdown(
    period: str = Query(default="today"),
    custom_start: date | None = Query(default=None),
    custom_end: date | None = Query(default=None),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    start_utc, end_utc, period_label = _window_utc(period, custom_start, custom_end)
    fx = await load_persisted_usd_inr_rate()
    rows = await _load_effective_usage_rows(
        db,
        user_id=current_user.id,
        start_utc=start_utc,
        end_utc=end_utc,
    )
    items, provider_totals = _aggregate_usage(
        rows,
        usd_inr_rate=fx.valid_value,
    )
    from_day = start_utc.replace(tzinfo=UTC).astimezone(API_USAGE_TZ).date()
    to_day = (
        (end_utc - timedelta(microseconds=1))
        .replace(tzinfo=UTC)
        .astimezone(API_USAGE_TZ)
        .date()
    )
    return {
        "timezone": str(API_USAGE_TZ),
        "period": period,
        "period_label": period_label,
        "from_date": from_day.isoformat(),
        "to_date": to_day.isoformat(),
        "usd_inr_rate": (
            round(fx.valid_value, 4) if fx.valid_value is not None else None
        ),
        "fx_source": fx.source,
        "fx_as_of": fx.as_of,
        "fx_status": fx.status,
        "request_metric": "outbound_provider_calls",
        "items": items,
        "provider_totals": provider_totals,
        "coverage_note": (
            "Authoritative provider snapshots and durably recorded provider responses "
            "take precedence over job-derived estimates. Job attribution is used only "
            "when a provider-ledger day is not available."
        ),
    }


@router.get("/llms/cost-history")
async def corrected_llm_cost_history(
    provider: str = Query(..., min_length=1),
    day_limit: int = Query(default=10, ge=1, le=100),
    run_limit: int = Query(default=10, ge=1, le=100),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    normalized_provider = provider.strip().lower()
    if normalized_provider not in LLM_PROVIDER_LABELS:
        raise HTTPException(400, detail="Invalid LLM provider.")

    legacy = await legacy_llm_cost_history(
        provider=normalized_provider,
        day_limit=day_limit,
        run_limit=run_limit,
        db=db,
        current_user=current_user,
    )
    payload = legacy.model_dump(mode="json")
    today = datetime.now(API_USAGE_TZ).date()
    oldest_day = today - timedelta(days=day_limit - 1)
    start_utc, end_utc, _ = _window_utc("custom", oldest_day, today)
    rows = await _load_effective_usage_rows(
        db,
        user_id=current_user.id,
        start_utc=start_utc,
        end_utc=end_utc,
    )
    fx = await load_persisted_usd_inr_rate()
    daily_totals: dict[str, dict[str, float | int]] = {
        (today - timedelta(days=offset)).isoformat(): {
            "cost": 0.0,
            "requests": 0,
            "tokens_in": 0,
            "tokens_out": 0,
        }
        for offset in range(day_limit)
    }
    for row in rows:
        if row["provider"] != normalized_provider:
            continue
        day_key = _usage_day_string(row["occurred_at"])
        totals = daily_totals.get(day_key)
        if totals is None:
            continue
        totals["cost"] = float(totals["cost"]) + float(row["estimated_cost"])
        totals["requests"] = int(totals["requests"]) + int(row["requests"])
        totals["tokens_in"] = int(totals["tokens_in"]) + int(row["tokens_in"])
        totals["tokens_out"] = int(totals["tokens_out"]) + int(row["tokens_out"])

    payload["days"] = [
        {
            "date": day_key,
            "estimated_cost": round(float(totals["cost"]), 6),
            "estimated_cost_inr": _convert_usd_to_inr(
                float(totals["cost"]), fx.valid_value
            ),
            "requests": int(totals["requests"]),
            "tokens_in": int(totals["tokens_in"]),
            "tokens_out": int(totals["tokens_out"]),
        }
        for day_key, totals in sorted(daily_totals.items(), reverse=True)
    ]
    payload["request_metric"] = "outbound_provider_calls"
    payload["coverage_note"] = (
        "Provider-ledger totals take precedence over reconstructed job estimates. "
        "The legacy run list remains job-oriented."
    )
    return payload
