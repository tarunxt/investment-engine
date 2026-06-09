from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, time
import logging
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.google_sheets.service import GoogleSheetsService
from app.domains.jobs.models import Job
from app.domains.runs.models import Run, RunJob
from app.domains.api_usage.schemas import (
    LlmCostHistoryDay,
    LlmCostHistoryResponse,
    LlmCostHistoryRun,
    LlmPerformanceGroup,
    LlmPerformanceResponse,
    LlmScanPerformanceItem,
    LlmScanSummary,
)
from app.core.config import get_gemini_api_keys, settings, settings_loaded_at_utc
from app.infrastructure.database.session import get_async_db

router = APIRouter(prefix="/api-usage", tags=["api-usage"])


IST = ZoneInfo("Asia/Kolkata")
logger = logging.getLogger(__name__)
_google_sheets_service = GoogleSheetsService()

SCAN_MARKERS: tuple[tuple[str, str], ...] = (
    ("[ZERODHA_EVENTS]", "Zerodha event scan"),
    ("[ZERODHA_THREATS]", "Zerodha threat scan"),
    ("[INDMONEY_US_EVENTS]", "INDmoney US event scan"),
    ("[INDMONEY_US_THREATS]", "INDmoney US threat scan"),
    ("[REBALANCE_TABLE_REPAIR]", "Portfolio rebalance repair"),
)
TERMINAL_FAILED_STATUSES = {"failed", "cancelled"}
TERMINAL_PASSED_STATUSES = {"completed"}
EXPORT_PASSED_STATUSES = {"completed", "success", "succeeded", "exported"}
EXPORT_FAILED_STATUSES = {"failed", "error"}


def _scan_type_for_job(job: Job, run_job: RunJob | None) -> str:
    if run_job is not None:
        stage_label = f"stage {run_job.stage}"
        return f"Multi-LLM run {stage_label}"

    prompt = job.prompt or ""
    for marker, label in SCAN_MARKERS:
        if marker in prompt:
            return label

    return "Single LLM job"


def _duration_ms(started_at: datetime | None, finished_at: datetime | None) -> int | None:
    if not started_at or not finished_at:
        return None
    return max(0, int((finished_at - started_at).total_seconds() * 1000))


def _sheet_export_passed(export_status: str | None) -> bool | None:
    if not export_status:
        return None
    normalized = export_status.lower()
    if normalized in EXPORT_PASSED_STATUSES:
        return True
    if normalized in EXPORT_FAILED_STATUSES:
        return False
    return None


def _build_llm_scan_summary(scan_type: str, scans: list[LlmScanPerformanceItem]) -> LlmScanSummary:
    durations = [scan.time_taken_ms for scan in scans if scan.time_taken_ms is not None]
    return LlmScanSummary(
        scan_type=scan_type,
        total_scans=len(scans),
        processing_passed=sum(1 for scan in scans if scan.processing_passed),
        processing_failed=sum(1 for scan in scans if scan.status.lower() in TERMINAL_FAILED_STATUSES),
        sheet_export_passed=sum(1 for scan in scans if scan.sheet_export_passed is True),
        sheet_export_failed=sum(1 for scan in scans if scan.sheet_export_passed is False),
        total_cost=round(sum(scan.estimated_cost or 0 for scan in scans), 6),
        avg_time_taken_ms=round(sum(durations) / len(durations)) if durations else None,
    )


def _build_llm_group(provider: str, model: str, scans: list[LlmScanPerformanceItem]) -> LlmPerformanceGroup:
    durations = [scan.time_taken_ms for scan in scans if scan.time_taken_ms is not None]
    scans_by_type: dict[str, list[LlmScanPerformanceItem]] = {}
    for scan in scans:
        scans_by_type.setdefault(scan.scan_type, []).append(scan)

    summaries = [
        _build_llm_scan_summary(scan_type, sorted(type_scans, key=lambda item: item.created_at, reverse=True))
        for scan_type, type_scans in sorted(scans_by_type.items())
    ]

    return LlmPerformanceGroup(
        provider=provider,
        model=model,
        llm_key=f"{provider}:{model}",
        total_scans=len(scans),
        processing_passed=sum(1 for scan in scans if scan.processing_passed),
        processing_failed=sum(1 for scan in scans if scan.status.lower() in TERMINAL_FAILED_STATUSES),
        sheet_export_passed=sum(1 for scan in scans if scan.sheet_export_passed is True),
        sheet_export_failed=sum(1 for scan in scans if scan.sheet_export_passed is False),
        total_cost=round(sum(scan.estimated_cost or 0 for scan in scans), 6),
        avg_time_taken_ms=round(sum(durations) / len(durations)) if durations else None,
        scan_summaries=summaries,
        scans=sorted(scans, key=lambda item: item.created_at, reverse=True),
    )

USD_INR_FALLBACK = 83.50
FX_SOURCE = "https://open.er-api.com/v6/latest/USD"


LLM_PROVIDER_LABELS = {
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "gemini": "Gemini",
    "deepseek": "DeepSeek",
}


def _normalize_llm_provider(provider: str) -> str:
    normalized = provider.strip().lower()
    if normalized not in LLM_PROVIDER_LABELS:
        raise HTTPException(400, detail="Invalid LLM provider.")
    return normalized


def _ist_day_string(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo("UTC"))
    return dt.astimezone(IST).date().isoformat()


@dataclass
class ApiUsageItem:
    name: str
    category: str
    configured: bool
    daily_requests: int
    daily_tokens_in: int
    daily_tokens_out: int
    daily_estimated_cost: float
    daily_estimated_cost_inr: float
    daily_limit_requests: int | None
    notes: str | None
    console_url: str | None
    gemini_key_index: int | None = None
    gemini_key_masked: str | None = None
    gemini_key_in_use: bool = False
    gemini_key_consumed: bool = False
    gemini_key_hidden_default: bool = False


def _mask_api_key(key: str) -> str:
    if len(key) <= 10:
        return f"{key[:2]}***"
    return f"{key[:6]}...{key[-4:]}"


def _to_naive_utc(dt: datetime) -> datetime:
    return dt.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)


def _window_utc(
    period: str,
    custom_start: date | None = None,
    custom_end: date | None = None,
) -> tuple[datetime, datetime, str]:
    now_ist = datetime.now(IST)
    day_start_ist = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)

    if period == "today":
        start_ist = day_start_ist
        end_ist = day_start_ist + timedelta(days=1)
        label = "Today"
    elif period == "week":
        # Monday-start week in IST
        start_ist = day_start_ist - timedelta(days=day_start_ist.weekday())
        end_ist = day_start_ist + timedelta(days=1)
        label = "This week"
    elif period == "month":
        start_ist = day_start_ist.replace(day=1)
        end_ist = day_start_ist + timedelta(days=1)
        label = "This month"
    elif period == "custom":
        if custom_start is None or custom_end is None:
            raise HTTPException(400, detail="custom_start and custom_end are required for custom period.")
        if custom_end < custom_start:
            raise HTTPException(400, detail="custom_end must be on or after custom_start.")
        start_ist = datetime.combine(custom_start, time.min, tzinfo=IST)
        end_ist = datetime.combine(custom_end + timedelta(days=1), time.min, tzinfo=IST)
        if (custom_end - custom_start).days > 365:
            raise HTTPException(400, detail="Custom range cannot exceed 366 days.")
        label = f"Custom ({custom_start.isoformat()} to {custom_end.isoformat()})"
    else:
        raise HTTPException(400, detail="Invalid period. Use today, week, month, or custom.")

    # jobs.created_at is stored as a naive UTC timestamp in Postgres, so the
    # query window must also be naive UTC to avoid asyncpg datetime coercion
    # errors when filtering.
    return _to_naive_utc(start_ist), _to_naive_utc(end_ist), label


async def _fetch_usd_inr_rate() -> tuple[float, str]:
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(FX_SOURCE)
            resp.raise_for_status()
            payload = resp.json()
            inr_rate = float((payload.get("rates") or {}).get("INR"))
            if inr_rate > 0:
                return inr_rate, FX_SOURCE
    except Exception as exc:  # pragma: no cover - fallback is expected in outages
        logger.warning("USD/INR live rate fetch failed, using fallback: %s", exc)
    return USD_INR_FALLBACK, "fallback"


@router.get("/summary")
async def api_usage_summary(
    period: str = Query(default="today"),
    custom_start: date | None = Query(default=None),
    custom_end: date | None = Query(default=None),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    google_sheets_configured = await run_in_threadpool(
        lambda: _google_sheets_service.is_configured
    )
    start_utc, end_utc, period_label = _window_utc(period, custom_start, custom_end)
    usd_inr_rate, fx_source = await _fetch_usd_inr_rate()

    rows = (
        await db.execute(
            select(
                Job.provider,
                func.count(Job.id),
                func.coalesce(func.sum(Job.tokens_in), 0),
                func.coalesce(func.sum(Job.tokens_out), 0),
                func.coalesce(func.sum(Job.estimated_cost), 0.0),
            )
            .where(
                Job.user_id == current_user.id,
                Job.created_at >= start_utc,
                Job.created_at < end_utc,
            )
            .group_by(Job.provider)
        )
    ).all()

    usage_by_provider = {
        provider: {
            "requests": int(count or 0),
            "tokens_in": int(tokens_in or 0),
            "tokens_out": int(tokens_out or 0),
            "cost": float(cost or 0.0),
        }
        for provider, count, tokens_in, tokens_out, cost in rows
    }

    gemini_keys = get_gemini_api_keys()
    gemini_slots = list(gemini_keys)
    while len(gemini_slots) < 4:
        gemini_slots.append(None)
    configured_gemini_keys = [k for k in gemini_keys if k]

    providers = [
        (
            "OpenAI",
            "openai",
            bool(settings.openai_api_key),
            "https://platform.openai.com/usage",
        ),
        (
            "Anthropic",
            "anthropic",
            bool(settings.anthropic_api_key),
            "https://console.anthropic.com/settings/usage",
        ),
        (
            "Gemini",
            "gemini",
            bool(configured_gemini_keys),
            "https://aistudio.google.com/usage?timeRange=last-28-days",
        ),
        (
            "DeepSeek",
            "deepseek",
            bool(settings.deepseek_api_key),
            "https://platform.deepseek.com/usage",
        ),
    ]

    items: list[ApiUsageItem] = []
    for label, key, configured, console_url in providers:
        usage = usage_by_provider.get(key, {})
        usd_cost = round(usage.get("cost", 0.0), 6)

        if key == "gemini":
            total_requests = usage.get("requests", 0)
            total_tokens_in = usage.get("tokens_in", 0)
            total_tokens_out = usage.get("tokens_out", 0)
            # Existing jobs table tracks usage at provider-level. Keep compatibility by
            # assigning tracked usage to active key (index 1) until per-key persistence exists.
            for index, key_value in enumerate(gemini_slots):
                is_configured_key = bool(key_value)
                in_use = index == 0 and is_configured_key
                consumed = in_use and total_requests > 0
                hidden_default = is_configured_key and not in_use and not consumed
                items.append(
                    ApiUsageItem(
                        name=f"Gemini API Key {index + 1}",
                        category="LLM",
                        configured=is_configured_key,
                        daily_requests=total_requests if consumed else 0,
                        daily_tokens_in=total_tokens_in if consumed else 0,
                        daily_tokens_out=total_tokens_out if consumed else 0,
                        daily_estimated_cost=usd_cost if consumed else 0.0,
                        daily_estimated_cost_inr=round((usd_cost if consumed else 0.0) * usd_inr_rate, 4),
                        daily_limit_requests=None,
                        notes="Primary key is used first; fallback keys are used automatically on quota/rate-limit and transient provider errors.",
                        console_url=console_url,
                        gemini_key_index=index + 1,
                        gemini_key_masked=_mask_api_key(key_value) if key_value else None,
                        gemini_key_in_use=in_use,
                        gemini_key_consumed=consumed,
                        gemini_key_hidden_default=hidden_default,
                    )
                )
            continue

        items.append(
            ApiUsageItem(
                name=label,
                category="LLM",
                configured=configured,
                daily_requests=usage.get("requests", 0),
                daily_tokens_in=usage.get("tokens_in", 0),
                daily_tokens_out=usage.get("tokens_out", 0),
                daily_estimated_cost=usd_cost,
                daily_estimated_cost_inr=round(usd_cost * usd_inr_rate, 4),
                daily_limit_requests=None,
                notes="Daily request limit depends on provider plan/quota.",
                console_url=console_url,
            )
        )

    items.extend(
        [
            ApiUsageItem(
                name="Google Sheets API",
                category="Integration",
                configured=google_sheets_configured,
                daily_requests=0,
                daily_tokens_in=0,
                daily_tokens_out=0,
                daily_estimated_cost=0.0,
                daily_estimated_cost_inr=0.0,
                daily_limit_requests=None,
                notes="Usage from Google console quotas; app-side token metrics not tracked.",
                console_url="https://console.cloud.google.com/apis/api/sheets.googleapis.com/quotas",
            ),
            ApiUsageItem(
                name="Zerodha API",
                category="Broker",
                configured=bool(settings.zerodha_api_key and settings.zerodha_api_secret),
                daily_requests=0,
                daily_tokens_in=0,
                daily_tokens_out=0,
                daily_estimated_cost=0.0,
                daily_estimated_cost_inr=0.0,
                daily_limit_requests=None,
                notes="Kite limits are account-specific.",
                console_url="https://kite.trade/docs/connect/v3/exceptions/#api-rate-limit",
            ),
            ApiUsageItem(
                name="Tavily Search API",
                category="Search",
                configured=bool(settings.tavily_api_key),
                daily_requests=0,
                daily_tokens_in=0,
                daily_tokens_out=0,
                daily_estimated_cost=0.0,
                daily_estimated_cost_inr=0.0,
                daily_limit_requests=None,
                notes="Used by DeepSeek tool-calling for live web search.",
                console_url="https://app.tavily.com/home",
            ),
        ]
    )

    return {
        "timezone": "Asia/Kolkata",
        "date": datetime.now(IST).date().isoformat(),
        "last_env_loaded_at_utc": settings_loaded_at_utc,
        "period": period,
        "period_label": period_label,
        "from_date": (custom_start.isoformat() if custom_start else None),
        "to_date": (custom_end.isoformat() if custom_end else None),
        "usd_inr_rate": round(usd_inr_rate, 4),
        "fx_source": fx_source,
        "items": [asdict(item) for item in items],
    }


@router.get("/llms/cost-history", response_model=LlmCostHistoryResponse)
async def llm_cost_history(
    provider: str = Query(..., min_length=1),
    day_limit: int = Query(default=10, ge=1, le=100),
    run_limit: int = Query(default=10, ge=1, le=100),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    normalized_provider = _normalize_llm_provider(provider)
    usd_inr_rate, _fx_source = await _fetch_usd_inr_rate()

    today_ist = datetime.now(IST).date()
    oldest_day = today_ist - timedelta(days=day_limit - 1)
    start_ist = datetime.combine(oldest_day, time.min, tzinfo=IST)
    end_ist = datetime.combine(today_ist + timedelta(days=1), time.min, tzinfo=IST)
    start_utc = _to_naive_utc(start_ist)
    end_utc = _to_naive_utc(end_ist)

    day_rows = (
        await db.execute(
            select(Job)
            .where(
                Job.user_id == current_user.id,
                Job.provider == normalized_provider,
                Job.created_at >= start_utc,
                Job.created_at < end_utc,
            )
            .order_by(Job.created_at.desc(), Job.id.desc())
        )
    ).scalars().all()

    daily_totals: dict[str, dict[str, float | int]] = {
        (today_ist - timedelta(days=offset)).isoformat(): {
            "cost": 0.0,
            "requests": 0,
            "tokens_in": 0,
            "tokens_out": 0,
        }
        for offset in range(day_limit)
    }
    for job in day_rows:
        day_key = _ist_day_string(job.created_at)
        totals = daily_totals.get(day_key)
        if totals is None:
            continue
        totals["cost"] = float(totals["cost"]) + float(job.estimated_cost or 0.0)
        totals["requests"] = int(totals["requests"]) + 1
        totals["tokens_in"] = int(totals["tokens_in"]) + int(job.tokens_in or 0)
        totals["tokens_out"] = int(totals["tokens_out"]) + int(job.tokens_out or 0)

    run_jobs = (
        await db.execute(
            select(Job)
            .where(
                Job.user_id == current_user.id,
                Job.provider == normalized_provider,
            )
            .order_by(Job.created_at.desc(), Job.id.desc())
            .limit(run_limit)
        )
    ).scalars().all()

    total_runs = int(
        await db.scalar(
            select(func.count(Job.id)).where(
                Job.user_id == current_user.id,
                Job.provider == normalized_provider,
            )
        )
        or 0
    )

    days = [
        LlmCostHistoryDay(
            date=day_key,
            estimated_cost=round(float(totals["cost"]), 6),
            estimated_cost_inr=round(float(totals["cost"]) * usd_inr_rate, 4),
            requests=int(totals["requests"]),
            tokens_in=int(totals["tokens_in"]),
            tokens_out=int(totals["tokens_out"]),
        )
        for day_key, totals in sorted(daily_totals.items(), reverse=True)
    ]

    runs = []
    for job in run_jobs:
        status = job.status.value if hasattr(job.status, "value") else str(job.status)
        cost = float(job.estimated_cost or 0.0)
        runs.append(
            LlmCostHistoryRun(
                job_id=job.id,
                model=job.model,
                status=status,
                timestamp=job.created_at,
                estimated_cost=round(cost, 6),
                estimated_cost_inr=round(cost * usd_inr_rate, 4),
                tokens_in=job.tokens_in,
                tokens_out=job.tokens_out,
            )
        )

    return LlmCostHistoryResponse(
        provider=normalized_provider,
        name=LLM_PROVIDER_LABELS[normalized_provider],
        timezone="Asia/Kolkata",
        usd_inr_rate=round(usd_inr_rate, 4),
        generated_at=datetime.now(ZoneInfo("UTC")),
        day_limit=day_limit,
        run_limit=run_limit,
        days=days,
        runs=runs,
        total_runs=total_runs,
        has_more_days=day_limit < 100,
        has_more_runs=total_runs > len(runs),
    )


@router.get("/llms/performance", response_model=LlmPerformanceResponse)
async def llm_performance(
    limit: int = Query(default=500, ge=1, le=1000),
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    rows = (
        await db.execute(
            select(Job, RunJob, Run)
            .outerjoin(RunJob, RunJob.job_id == Job.id)
            .outerjoin(Run, Run.id == RunJob.run_id)
            .where(Job.user_id == current_user.id)
            .order_by(Job.created_at.desc(), Job.id.desc())
            .limit(limit)
        )
    ).all()

    scans_by_llm: dict[tuple[str, str], list[LlmScanPerformanceItem]] = {}
    for job, run_job, run in rows:
        status = job.status.value if hasattr(job.status, "value") else str(job.status)
        export_status = job.export_status or (run.export_status if run is not None else None)
        sheet_export_passed = _sheet_export_passed(export_status)
        normalized_status = status.lower()
        processing_passed = (
            True
            if normalized_status in TERMINAL_PASSED_STATUSES
            else False if normalized_status in TERMINAL_FAILED_STATUSES else None
        )
        error_message = job.error_message or (run.export_error if run is not None else None)
        export_error = job.export_error or (run.export_error if run is not None else None)
        item = LlmScanPerformanceItem(
            job_id=job.id,
            run_id=run.id if run is not None else None,
            stage=run_job.stage if run_job is not None else None,
            scan_type=_scan_type_for_job(job, run_job),
            provider=job.provider,
            model=job.model,
            status=status,
            processing_passed=processing_passed,
            sheet_export_passed=sheet_export_passed,
            export_status=export_status,
            created_at=job.created_at,
            updated_at=job.updated_at,
            exported_at=job.exported_at or (run.exported_at if run is not None else None),
            time_taken_ms=_duration_ms(job.created_at, job.updated_at),
            tokens_in=job.tokens_in,
            tokens_out=job.tokens_out,
            estimated_cost=job.estimated_cost,
            error_message=error_message,
            export_error=export_error,
        )
        scans_by_llm.setdefault((job.provider, job.model), []).append(item)

    groups = [
        _build_llm_group(provider, model, scans)
        for (provider, model), scans in sorted(scans_by_llm.items())
    ]

    return LlmPerformanceResponse(
        total_llms=len(groups),
        total_scans=sum(group.total_scans for group in groups),
        generated_at=datetime.now(ZoneInfo("UTC")),
        groups=groups,
    )
