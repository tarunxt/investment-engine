from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
import logging
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
import httpx
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.core.config import settings
from app.infrastructure.database.session import get_async_db

router = APIRouter(prefix="/api-usage", tags=["api-usage"])


IST = ZoneInfo("Asia/Kolkata")
logger = logging.getLogger(__name__)

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


def _day_window_utc() -> tuple[datetime, datetime]:
    now_ist = datetime.now(IST)
    day_start_ist = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end_ist = day_start_ist + timedelta(days=1)
    # jobs.created_at is stored as a naive UTC timestamp in Postgres, so the
    # query window must also be naive UTC to avoid asyncpg datetime coercion
    # errors when filtering.
    start_utc = day_start_ist.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)
    end_utc = day_end_ist.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)
    return start_utc, end_utc


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
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    start_utc, end_utc = _day_window_utc()
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
            bool(settings.gemini_api_key),
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
                configured=bool(settings.google_client_id and settings.google_client_secret),
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
        "usd_inr_rate": round(usd_inr_rate, 4),
        "fx_source": fx_source,
        "items": [asdict(item) for item in items],
    }
