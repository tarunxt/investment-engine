from __future__ import annotations

from contextvars import ContextVar, Token
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
import logging

from sqlalchemy.exc import IntegrityError

from app.domains.api_usage.models import LlmProviderUsageCallRecord
from app.infrastructure.database.sync_session import SyncSessionLocal

logger = logging.getLogger("app")


@dataclass(frozen=True)
class ProviderUsageContext:
    user_id: int | None
    job_id: int | None
    execution_id: str | None = None
    job_attempt: int | None = None
    run_id: str | None = None
    workflow_id: str | None = None
    market: str | None = None
    stage: str | None = None
    sample_id: str | None = None
    requested_provider: str | None = None
    requested_model: str | None = None
    phase: str | None = None
    evidence_hash: str | None = None
    schema_hash: str | None = None
    # Per execution, never shared across jobs or independent samples.
    last_attempt: dict[str, str] = field(default_factory=dict, compare=False)


_provider_usage_context: ContextVar[ProviderUsageContext | None] = ContextVar(
    "provider_usage_context", default=None
)


def set_provider_usage_context(
    *, user_id: int | None, job_id: int | None,
    execution_id: str | None = None, job_attempt: int | None = None,
    run_id: str | None = None, workflow_id: str | None = None,
    market: str | None = None, stage: str | None = None,
    sample_id: str | None = None, requested_provider: str | None = None,
    requested_model: str | None = None, evidence_hash: str | None = None,
    schema_hash: str | None = None,
) -> Token[ProviderUsageContext | None] | None:
    return _provider_usage_context.set(
        ProviderUsageContext(
            user_id=int(user_id) if user_id is not None else None, job_id=job_id,
            execution_id=execution_id, job_attempt=job_attempt,
            run_id=str(run_id) if run_id is not None else None,
            workflow_id=str(workflow_id) if workflow_id is not None else None,
            market=market, stage=stage, sample_id=sample_id,
            requested_provider=requested_provider, requested_model=requested_model,
            evidence_hash=evidence_hash, schema_hash=schema_hash,
        )
    )


def get_provider_usage_context() -> ProviderUsageContext | None:
    return _provider_usage_context.get()


@contextmanager
def provider_usage_phase(phase: str):
    """Label a job-level repair without passing telemetry into a provider API."""
    context = get_provider_usage_context()
    token = _provider_usage_context.set(replace(context, phase=phase)) if context else None
    try:
        yield
    finally:
        reset_provider_usage_context(token)


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
    if context is None or context.user_id is None or not provider_request_id:
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
