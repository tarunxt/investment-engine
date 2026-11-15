from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation

import httpx
from celery.exceptions import MaxRetriesExceededError
from sqlalchemy import select

from app.core.logging import get_logger
from app.domains.fx_rates.models import FxRate
from app.domains.fx_rates.service import (
    USD_INR_BASE_CURRENCY,
    USD_INR_QUOTE_CURRENCY,
)
from app.infrastructure.database.sync_session import SyncSessionLocal
from app.infrastructure.messaging.celery_app import celery

logger = get_logger(__name__)

USD_INR_PROVIDER_URL = "https://open.er-api.com/v6/latest/USD"
_MIN_PLAUSIBLE_USD_INR_RATE = Decimal("20")
_MAX_PLAUSIBLE_USD_INR_RATE = Decimal("200")
_MAX_PROVIDER_AGE = timedelta(days=7)
_MAX_FUTURE_SKEW = timedelta(minutes=5)


def parse_verified_usd_inr_payload(
    payload: object,
    *,
    now: datetime | None = None,
) -> tuple[Decimal, datetime]:
    if not isinstance(payload, dict):
        raise ValueError("FX provider response must be a JSON object")
    if payload.get("result") != "success" or payload.get("base_code") != "USD":
        raise ValueError("FX provider did not return a successful USD rate set")

    rates = payload.get("rates")
    if not isinstance(rates, dict):
        raise ValueError("FX provider response is missing rates")
    try:
        rate = Decimal(str(rates["INR"]))
    except (KeyError, InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError("FX provider response has no valid INR rate") from exc
    if not (_MIN_PLAUSIBLE_USD_INR_RATE <= rate <= _MAX_PLAUSIBLE_USD_INR_RATE):
        raise ValueError("FX provider INR rate failed the configured sanity bounds")

    timestamp = payload.get("time_last_update_unix")
    if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)):
        raise ValueError("FX provider response has no verified update timestamp")
    as_of = datetime.fromtimestamp(timestamp, tz=UTC)
    current_time = now or datetime.now(UTC)
    if as_of < current_time - _MAX_PROVIDER_AGE:
        raise ValueError("FX provider rate is too old to persist as verified")
    if as_of > current_time + _MAX_FUTURE_SKEW:
        raise ValueError("FX provider timestamp is unexpectedly in the future")
    return rate, as_of


def _retry_countdown(attempt: int) -> int:
    return min(15 * (2**attempt), 120)


@celery.task(bind=True, max_retries=3, soft_time_limit=15, time_limit=20)
def refresh_usd_inr_rate(self):
    fetched_at = datetime.now(UTC)
    try:
        with httpx.Client(timeout=8.0) as client:
            response = client.get(USD_INR_PROVIDER_URL)
            response.raise_for_status()
            rate, source_as_of = parse_verified_usd_inr_payload(
                response.json(),
                now=fetched_at,
            )

        with SyncSessionLocal() as db:
            existing = db.scalar(
                select(FxRate).where(
                    FxRate.base_currency == USD_INR_BASE_CURRENCY,
                    FxRate.quote_currency == USD_INR_QUOTE_CURRENCY,
                    FxRate.source == USD_INR_PROVIDER_URL,
                    FxRate.source_as_of == source_as_of,
                )
            )
            if existing is None:
                db.add(
                    FxRate(
                        base_currency=USD_INR_BASE_CURRENCY,
                        quote_currency=USD_INR_QUOTE_CURRENCY,
                        rate=rate,
                        source=USD_INR_PROVIDER_URL,
                        source_as_of=source_as_of,
                        fetched_at=fetched_at,
                        verified=True,
                    )
                )
            else:
                existing.rate = rate
                existing.fetched_at = fetched_at
                existing.verified = True
            db.commit()

        logger.info(
            "Persisted verified USD/INR rate from %s as of %s",
            USD_INR_PROVIDER_URL,
            source_as_of.isoformat(),
        )
        return {
            "status": "completed",
            "source": USD_INR_PROVIDER_URL,
            "as_of": source_as_of.isoformat(),
        }
    except Exception as exc:
        logger.exception("Verified USD/INR refresh failed")
        try:
            raise self.retry(
                exc=exc,
                countdown=_retry_countdown(self.request.retries),
            )
        except MaxRetriesExceededError:
            return {
                "status": "failed",
                "error": exc.__class__.__name__,
            }
