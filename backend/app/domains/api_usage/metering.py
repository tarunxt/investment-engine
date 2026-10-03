"""Fail-open telemetry at observable provider call boundaries, not hidden SDK retries."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
import hashlib
import json
import logging
import math
import re
from time import perf_counter
from uuid import uuid4

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError

from app.domains.api_usage.models import ApiUsageAttemptEvent
from app.domains.api_usage.recorder import get_provider_usage_context
from app.infrastructure.database.sync_session import SyncSessionLocal

logger = logging.getLogger("app")
# These are repository tariff snapshots, not verified current provider prices.
TARIFF_VERSION = "repository-c37e6ce7-v1"
# The old tables did not supply an effective date; do not invent one.
TARIFF_EFFECTIVE_DATE = None


def content_hash(value: object) -> str | None:
    if value is None:
        return None
    try:
        payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    except Exception:
        # Hashing is telemetry too: malformed/deep SDK arguments must not block
        # an otherwise valid upstream invocation.
        return None
    return hashlib.sha256(payload.encode()).hexdigest()


def _attr(obj: object, name: str):
    try:
        return obj.get(name) if isinstance(obj, Mapping) else getattr(obj, name, None)
    except Exception:
        # In particular, exception properties must never replace the original
        # provider failure while the context manager is unwinding.
        return None


def _text(value: object, limit: int = 128) -> str | None:
    # Reject arbitrary objects; never serialize entire responses or errors.
    return value[:limit] if isinstance(value, str) and value else None


def _number(value: object) -> int | float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return value
    return None


def _first(obj: object, *names: str):
    for name in names:
        value = _attr(obj, name)
        if value is not None:
            return value
    return None


def _reported_usage(response: object, provider: str) -> dict | None:
    usage = _first(response, "usage", "usage_metadata")
    if usage is None:
        return None
    aliases = {
        "input_tokens": ("input_tokens", "prompt_tokens", "prompt_token_count"),
        "output_tokens": ("output_tokens", "completion_tokens", "candidates_token_count"),
        "total_tokens": ("total_tokens", "total_token_count"),
        "cache_read_input_tokens": ("cache_read_input_tokens", "prompt_cache_hit_tokens", "cached_content_token_count"),
        "cache_write_input_tokens": ("cache_creation_input_tokens",),
        "cache_miss_input_tokens": ("prompt_cache_miss_tokens",),
        "reasoning_tokens": ("thoughts_token_count",),
        "tool_use_prompt_tokens": ("tool_use_prompt_token_count",),
        "search_units": ("credits",),
    }
    result = {key: _number(_first(usage, *names)) for key, names in aliases.items()}
    for container_name, fields in {
        "input_tokens_details": ("cached_tokens", "audio_tokens"),
        "prompt_tokens_details": ("cached_tokens", "audio_tokens"),
        "output_tokens_details": ("reasoning_tokens", "audio_tokens"),
        "completion_tokens_details": ("reasoning_tokens", "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"),
        "server_tool_use": ("web_search_requests", "web_fetch_requests"),
    }.items():
        details = _attr(usage, container_name)
        if details is not None:
            result[container_name] = {key: _number(_attr(details, key)) for key in fields}
    # No unknown provider fields are retained: usage objects can contain text/secrets.
    return result


def _merge_usage(previous: dict | None, snapshot: dict) -> dict:
    """Keep the latest observed value; omitted cumulative fields are not zero."""
    merged = dict(previous or {})
    for key, value in snapshot.items():
        if isinstance(value, dict):
            merged[key] = _merge_usage(merged.get(key), value)
        elif value is not None or key not in merged:
            merged[key] = value
    return merged


def _estimate(usage: dict | None, rates: dict | None) -> tuple[float | None, dict | None]:
    if usage is None or rates is None:
        return None, None
    tokens_in, tokens_out = usage.get("input_tokens"), usage.get("output_tokens")
    if tokens_in is None or tokens_out is None:
        return None, None
    inferred = None
    if "cache_hit_input" in rates:
        hit, miss = usage.get("cache_read_input_tokens"), usage.get("cache_miss_input_tokens")
        if hit is None and miss is None:
            # This is an explicit upper-rate assumption, never reported cache usage.
            hit, miss = 0, tokens_in
            inferred = {"cache_read_input_tokens": hit, "cache_miss_input_tokens": miss,
                        "basis": "unreported_cache_assumed_uncached_for_tariff_estimate"}
        elif hit is None:
            hit = max(0, tokens_in - miss)
            inferred = {"cache_read_input_tokens": hit, "basis": "input_minus_reported_cache_miss"}
        elif miss is None:
            miss = max(0, tokens_in - hit)
            inferred = {"cache_miss_input_tokens": miss, "basis": "input_minus_reported_cache_read"}
        if hit + miss != tokens_in:
            return None, inferred
        cost = hit * rates["cache_hit_input"] + miss * rates["cache_miss_input"] + tokens_out * rates["output"]
    else:
        cost = tokens_in * rates["input"] + tokens_out * rates["output"]
        inferred = {"basis": "listed_input_output_rates_only_excludes_unpriced_cache_reasoning_tools"}
    return round(cost / 1_000_000, 12), inferred


def _persist_attempt(values: dict) -> None:
    """Append immutable lifecycle events with database-enforced idempotency.

    A start event remains visible after process death. Replaying an event is a
    no-op; separate attempts delivering one response retain a duplicate fact.
    """
    try:
        with SyncSessionLocal() as db:
            candidate = dict(values)
            # Initial insert plus at most one racing claim per identity key.
            # All conflict detection stays under database unique constraints.
            for _ in range(3):
                try:
                    db.add(ApiUsageAttemptEvent(**candidate))
                    db.commit()
                    return
                except IntegrityError:
                    db.rollback()
                    existing = db.scalar(select(ApiUsageAttemptEvent).where(
                        ApiUsageAttemptEvent.attempt_id == values["attempt_id"],
                        ApiUsageAttemptEvent.event_kind == values["event_kind"],
                    ))
                    if existing is not None:
                        return
                    fields = ("response_dedupe_key", "request_dedupe_key")
                    keys = [getattr(ApiUsageAttemptEvent, field) == values[field]
                            for field in fields if values.get(field)]
                    matches = list(db.scalars(select(ApiUsageAttemptEvent).where(or_(*keys)))) if keys else []
                    if not matches:
                        raise
                    canonical = matches[0]
                    candidate = dict(
                        values,
                        duplicate_of_attempt_id=canonical.duplicate_of_attempt_id or canonical.attempt_id,
                        tariff_estimated_cost_usd=None,
                        tool_tariff_estimated_cost_usd=None,
                    )
                    # Preserve a newly learned, unclaimed identity alias on the
                    # duplicate event. A later request-only/response-only replay
                    # can then resolve to the same original charge.
                    for field in fields:
                        if any(getattr(match, field) == values.get(field) for match in matches):
                            candidate[field] = None
            raise RuntimeError("API attempt identity conflict did not settle")
    except Exception:
        # Never log request/response content or the DB exception's bound parameters.
        logger.warning("API attempt telemetry persistence failed: attempt=%s", values["attempt_id"])


def _previous_job_attempt(context) -> str | None:
    if not context or not context.job_id or not context.execution_id or not context.job_attempt:
        return None
    try:
        with SyncSessionLocal() as db:
            return db.scalar(select(ApiUsageAttemptEvent.attempt_id).where(
                ApiUsageAttemptEvent.job_id == context.job_id,
                ApiUsageAttemptEvent.execution_id == context.execution_id,
                ApiUsageAttemptEvent.job_attempt < context.job_attempt,
                ApiUsageAttemptEvent.sample_id == context.sample_id,
            ).order_by(ApiUsageAttemptEvent.started_at.desc()).limit(1))
    except Exception:
        logger.warning("API attempt retry linkage unavailable for job=%s", context.job_id)
        return None


class ApiAttempt:
    def __init__(self, *, provider: str, model: str | None, request: object,
                 phase: str = "request", tariff_rates: dict | None = None,
                 instrumentation_scope: str = "sdk_call_hidden_retries_unknown",
                 retry: bool = False, parent_attempt_id: str | None = None):
        self.context = get_provider_usage_context()
        context = self.context
        attempt_id = str(uuid4())
        previous = parent_attempt_id or (context.last_attempt.get("attempt_id") if context else None)
        previous_job = _previous_job_attempt(context) if previous is None else None
        previous = previous or previous_job
        self.values = {
            "attempt_id": attempt_id, "event_id": str(uuid4()), "event_kind": "started",
            "user_id": context.user_id if context else None,
            "job_id": context.job_id if context else None,
            "requested_provider": provider if phase == "search" else (context.requested_provider if context else None) or provider,
            "requested_model": model if phase == "search" else (context.requested_model if context else None) or model,
            "actual_provider": provider, "actual_model": None,
            "phase": context.phase if context and context.phase and phase == "request" else phase,
            "parent_attempt_id": previous,
            "retry_of_attempt_id": previous if retry or previous_job else None,
            "status": "started", "started_at": datetime.now(UTC),
            "prompt_hash": content_hash(request),
            "instrumentation_scope": instrumentation_scope,
            # This boundary is entered only when invoking upstream. Provider
            # cache hits and duplicate-response delivery are separate facts.
            "reuse_status": "not_reused",
            "tariff_version": TARIFF_VERSION if tariff_rates else None,
            "tariff_effective_date": TARIFF_EFFECTIVE_DATE,
            "tariff_rates": tariff_rates,
        }
        for field in ("execution_id", "job_attempt", "run_id", "workflow_id", "market", "stage", "sample_id", "evidence_hash", "schema_hash"):
            value = getattr(context, field, None)
            if field.endswith("_hash") and not (isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value)):
                value = None
            self.values[field] = value
        self._start = perf_counter()

    def __enter__(self):
        if self.context:
            self.context.last_attempt["attempt_id"] = self.values["attempt_id"]
        _persist_attempt(self.values)
        self._start = perf_counter()
        return self

    def observe(self, response: object) -> None:
        try:
            self._observe_response(response)
        except Exception:
            # SDK metadata evolves independently of the business response API.
            # An unexpected telemetry field must not fail a successful request.
            logger.warning("API usage metadata could not be read: attempt=%s", self.values["attempt_id"])

    def observe_search_results(self, count: int | None) -> None:
        """Record only an aggregate, never result bodies, URLs or queries."""
        if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
            self.values["search_result_count"] = count

    def _observe_response(self, response: object) -> None:
        values = self.values
        response_id = _text(_first(response, "id", "response_id"), 255)
        headers = _attr(response, "headers")
        request_id = _text(_first(response, "_request_id", "request_id"), 255)
        if not request_id and headers is not None:
            request_id = _text(_first(headers, "x-request-id", "request-id"), 255)
        if response_id:
            values["provider_response_id"] = response_id
        if request_id:
            values["provider_request_id"] = request_id
        for identity_kind in ("response", "request"):
            identity = values.get(f"provider_{identity_kind}_id")
            if not identity:
                continue
            # Credentials are server-wide: replay under another app user is
            # still the same upstream response, with a separate ownership fact.
            # Do not inspect/hash credentials to establish the current scope.
            values[f"{identity_kind}_dedupe_key"] = content_hash([values["actual_provider"], identity_kind, identity])
        actual_model = _text(_first(response, "model", "model_version"))
        if actual_model:
            values["actual_model"] = actual_model
        status = _attr(response, "status_code")
        if isinstance(status, int):
            values["http_status"] = status
        finish_reason = _text(_first(response, "stop_reason", "status"))
        choices = _first(response, "choices", "candidates") or []
        if choices:
            finish_reason = _text(_attr(choices[0], "finish_reason")) or finish_reason
        if finish_reason:
            values["finish_reason"] = finish_reason
        if values["phase"] == "search":
            results = response if isinstance(response, (list, tuple)) else _attr(response, "results")
            if isinstance(results, (list, tuple)):
                self.observe_search_results(len(results))
        usage = _reported_usage(response, values["actual_provider"])
        if usage is not None:
            # Streaming providers report cumulative snapshots, not deltas;
            # later partial snapshots must not erase already observed usage.
            usage = _merge_usage(values.get("reported_usage"), usage)
            values["reported_usage"] = usage
            values["tariff_estimated_cost_usd"], values["inferred_usage"] = _estimate(usage, values.get("tariff_rates"))

    def __exit__(self, exc_type, exc, traceback):
        if exc is not None:
            values = self.values
            values["status"] = "cancelled" if not isinstance(exc, Exception) or exc.__class__.__name__ in {"CancelledError", "SoftTimeLimitExceeded"} else "error"
            values["error_type"] = exc.__class__.__name__[:128]
            status = _first(exc, "status_code", "http_status")
            if isinstance(status, int):
                values["http_status"] = status
            request_id = _text(_attr(exc, "request_id"), 255)
            if request_id:
                values["provider_request_id"] = request_id
        else:
            self.values["status"] = "success"
        self.values["event_id"] = str(uuid4())
        self.values["event_kind"] = "finished"
        self.values["finished_at"] = datetime.now(UTC)
        self.values["latency_ms"] = max(0.0, (perf_counter() - self._start) * 1000)
        _persist_attempt(self.values)
        return False


def metered_call(call: Callable, *args, provider: str, meter_model: str | None,
                 phase: str = "request", tariff_rates: dict | None = None,
                 request_hash_input: object = None, instrumentation_scope: str = "sdk_call_hidden_retries_unknown",
                 **kwargs):
    """Pass upstream kwargs through unchanged; metering never controls retries."""
    with ApiAttempt(provider=provider, model=meter_model,
                    request={"args": args, "kwargs": kwargs} if request_hash_input is None else request_hash_input,
                    phase=phase, tariff_rates=tariff_rates,
                    instrumentation_scope=instrumentation_scope) as attempt:
        response = call(*args, **kwargs)
        attempt.observe(response)
        return response
