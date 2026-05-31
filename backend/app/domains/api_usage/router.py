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
from app.core.config import get_gemini_api_keys, settings, settings_loaded_at_utc
from app.infrastructure.database.session import get_async_db

router = APIRouter(prefix="/api-usage", tags=["api-usage"])


IST = ZoneInfo("Asia/Kolkata")
logger = logging.getLogger(__name__)
_google_sheets_service = GoogleSheetsService()

USD_INR_FALLBACK = 83.50
FX_SOURCE = "https://open.er-api.com/v6/latest/USD"


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
