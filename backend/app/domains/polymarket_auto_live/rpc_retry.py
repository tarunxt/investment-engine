"""Shared, bounded retry policy for Bullpen RPC writes.

Stage 3 has two execution paths (the legacy in-process path and durable
order-intent workers).  Keeping rate-limit detection and delay calculation in
one small module prevents the paths from silently developing different retry
semantics.
"""

from __future__ import annotations

import random
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any


_RATE_LIMIT_MARKERS = (
    "429",
    "too many requests",
    "rate limit",
    "rate-limit",
    "rate limited",
    "ratelimited",
    "rpc rate",
    "resource exhausted",
    "throttled",
    "throttle",
)
_RETRY_AFTER_PATTERN = re.compile(
    r"retry[- ]after\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?|[A-Za-z]{3},.+)$",
    re.IGNORECASE,
)


def _headers(value: object) -> Mapping[str, object] | None:
    if isinstance(value, Mapping):
        candidate = value.get("headers")
        if isinstance(candidate, Mapping):
            return candidate
    candidate = getattr(value, "headers", None)
    return candidate if isinstance(candidate, Mapping) else None


def _retry_after_value(value: object) -> object | None:
    for candidate in (value, getattr(value, "response", None)):
        headers = _headers(candidate)
        if headers is None:
            continue
        for key, item in headers.items():
            if str(key).lower() == "retry-after":
                return item
    if isinstance(value, Mapping):
        for key, item in value.items():
            if str(key).lower() == "retry-after":
                return item
    return None


def extract_retry_after_seconds(value: object) -> float | None:
    """Extract Retry-After from exception/response metadata or error text."""

    header_value = _retry_after_value(value)
    if header_value is not None:
        try:
            return max(0.0, float(header_value))
        except (TypeError, ValueError):
            try:
                parsed = parsedate_to_datetime(str(header_value))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=UTC)
                return max(0.0, (parsed.astimezone(UTC) - datetime.now(UTC)).total_seconds())
            except (TypeError, ValueError, OverflowError):
                pass

    text = str(value)
    match = _RETRY_AFTER_PATTERN.search(text)
    if not match:
        return None
    raw = match.group(1).strip()
    try:
        return max(0.0, float(raw))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(raw)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            return max(0.0, (parsed.astimezone(UTC) - datetime.now(UTC)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None


def is_rpc_rate_limited(value: object) -> bool:
    status_code = getattr(value, "status_code", None)
    if status_code is None and isinstance(value, Mapping):
        status_code = value.get("status_code") or value.get("status")
    if status_code is None:
        response = getattr(value, "response", None)
        status_code = getattr(response, "status_code", None)
    try:
        if int(status_code) == 429:
            return True
    except (TypeError, ValueError):
        pass
    if isinstance(value, Mapping):
        nested_response = value.get("response")
        if isinstance(nested_response, Mapping):
            try:
                if int(nested_response.get("status_code") or nested_response.get("status")) == 429:
                    return True
            except (TypeError, ValueError):
                pass
    text = str(value).lower()
    return any(marker in text for marker in _RATE_LIMIT_MARKERS)


def compute_rpc_retry_delay_seconds(
    *,
    attempt_number: int,
    initial_delay_seconds: float,
    max_delay_seconds: float,
    retry_after_seconds: float | None = None,
    random_value: float | None = None,
) -> float:
    """Return a bounded exponential delay with jitter.

    Retry-After is authoritative when supplied by Bullpen.  The fallback
    delay is deliberately capped before jitter so one bad response cannot
    produce an unbounded worker sleep.
    """

    if retry_after_seconds is not None:
        # Retry-After is an upstream instruction.  The total-wait budget is
        # the safety bound for an unusually large server supplied value.
        return max(0.0, float(retry_after_seconds))
    initial = max(0.0, float(initial_delay_seconds))
    maximum = max(initial, float(max_delay_seconds))
    exponent = max(0, int(attempt_number) - 1)
    base = min(maximum, initial * (2**exponent))
    jitter = random_value if random_value is not None else random.uniform(0.75, 1.25)
    return max(0.0, min(maximum, base * max(0.0, float(jitter))))


def retry_budget_allows(*, retry_count: int, total_wait_seconds: float, attempts: int, max_total_wait_seconds: float) -> bool:
    return retry_count < max(0, attempts) and total_wait_seconds <= max(0.0, max_total_wait_seconds)


__all__ = [
    "compute_rpc_retry_delay_seconds",
    "extract_retry_after_seconds",
    "is_rpc_rate_limited",
    "retry_budget_allows",
]
