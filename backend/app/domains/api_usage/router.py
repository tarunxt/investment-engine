from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.core.config import settings
from app.infrastructure.database.session import get_async_db

router = APIRouter(prefix="/api-usage", tags=["api-usage"])


IST = ZoneInfo("Asia/Kolkata")


@dataclass
class ApiUsageItem:
    name: str
    category: str
    configured: bool
    daily_requests: int
    daily_tokens_in: int
    daily_tokens_out: int
    daily_estimated_cost: float
    daily_limit_requests: int | None
    notes: str | None


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


@router.get("/summary")
async def api_usage_summary(
    db: AsyncSession = Depends(get_async_db),
    current_user: User = Depends(get_current_user),
):
    start_utc, end_utc = _day_window_utc()

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
        ("OpenAI", "openai", bool(settings.openai_api_key)),
        ("Anthropic", "anthropic", bool(settings.anthropic_api_key)),
        ("Gemini", "gemini", bool(settings.gemini_api_key)),
        ("DeepSeek", "deepseek", bool(settings.deepseek_api_key)),
    ]

    items: list[ApiUsageItem] = []
    for label, key, configured in providers:
        usage = usage_by_provider.get(key, {})
        items.append(
            ApiUsageItem(
                name=label,
                category="LLM",
                configured=configured,
                daily_requests=usage.get("requests", 0),
                daily_tokens_in=usage.get("tokens_in", 0),
                daily_tokens_out=usage.get("tokens_out", 0),
                daily_estimated_cost=round(usage.get("cost", 0.0), 6),
                daily_limit_requests=None,
                notes="Daily request limit depends on provider plan/quota.",
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
                daily_limit_requests=None,
                notes="Usage from Google console quotas; app-side token metrics not tracked.",
            ),
            ApiUsageItem(
                name="Zerodha API",
                category="Broker",
                configured=bool(settings.zerodha_api_key and settings.zerodha_api_secret),
                daily_requests=0,
                daily_tokens_in=0,
                daily_tokens_out=0,
                daily_estimated_cost=0.0,
                daily_limit_requests=None,
                notes="Kite limits are account-specific.",
            ),
            ApiUsageItem(
                name="Tavily Search API",
                category="Search",
                configured=bool(settings.tavily_api_key),
                daily_requests=0,
                daily_tokens_in=0,
                daily_tokens_out=0,
                daily_estimated_cost=0.0,
                daily_limit_requests=None,
                notes="Used by DeepSeek tool-calling for live web search.",
            ),
        ]
    )

    return {
        "timezone": "Asia/Kolkata",
        "date": datetime.now(IST).date().isoformat(),
        "items": [asdict(item) for item in items],
    }
