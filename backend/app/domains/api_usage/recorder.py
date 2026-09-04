from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass
from datetime import UTC, datetime
import logging

from sqlalchemy.exc import IntegrityError

from app.domains.api_usage.models import LlmProviderUsageCallRecord
from app.infrastructure.database.sync_session import SyncSessionLocal

logger = logging.getLogger("app")


@dataclass(frozen=True)
class ProviderUsageContext:
    user_id: int
    job_id: int | None


_provider_usage_context: ContextVar[ProviderUsageContext | None] = ContextVar(
    "provider_usage_context", default=None
)


def set_provider_usage_context(
    *, user_id: int | None, job_id: int | None
) -> Token[ProviderUsageContext | None] | None:
    if user_id is None:
        return None
    return _provider_usage_context.set(
        ProviderUsageContext(user_id=int(user_id), job_id=job_id)
    )


def reset_provider_usage_context(
    token: Token[ProviderUsageContext | None] | None,
) -> None:
    if token is not None:
        _provider_usage_context.reset(token)


def record_provider_usage_call(
    *,
    provider: str,
    model: str,
    provider_request_id: str | None,
    occurred_at: datetime | None,
    tokens_in: int,
    tokens_out: int,
    cache_hit_tokens: int,
    cache_miss_tokens: int,
    actual_cost: float,
) -> None:
    """Persist one provider response without risking the underlying AI request."""

    context = _provider_usage_context.get()
    if context is None or not provider_request_id:
        return

    timestamp = occurred_at or datetime.now(UTC)
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=UTC)

    try:
        with SyncSessionLocal() as db:
            db.add(
                LlmProviderUsageCallRecord(
                    user_id=context.user_id,
                    job_id=context.job_id,
                    provider=provider.strip().lower(),
                    model=model,
                    provider_request_id=provider_request_id,
                    occurred_at=timestamp,
                    tokens_in=max(0, int(tokens_in)),
                    tokens_out=max(0, int(tokens_out)),
                    cache_hit_tokens=max(0, int(cache_hit_tokens)),
                    cache_miss_tokens=max(0, int(cache_miss_tokens)),
                    actual_cost=max(0.0, float(actual_cost)),
                )
            )
            db.commit()
    except IntegrityError:
        # Celery retries can observe the same provider response more than once.
        logger.info(
            "Provider usage response %s/%s was already recorded",
            provider,
            provider_request_id,
        )
    except Exception:
        logger.exception(
            "Failed to persist provider usage response %s/%s",
            provider,
            provider_request_id,
        )
