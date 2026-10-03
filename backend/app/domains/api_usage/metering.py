"""Fail-open telemetry at observable provider call boundaries, not hidden SDK retries."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import UTC, datetime
import hashlib
import json
import logging
import re
from time import perf_counter
from uuid import uuid4

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError

from app.domains.api_usage.models import ApiUsageAttemptEvent
from app.domains.api_usage.recorder import get_provider_usage_context
from app.domains.api_usage.usage_metadata import (
    conflicting_usage_fields, extract_usage, has_reported_usage, number,
)
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
    return number(value)


def _first(obj: object, *names: str):
    for name in names:
        value = _attr(obj, name)
        if value is not None:
            return value
    return None


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
    if usage is None or not isinstance(rates, dict):
        return None, None
    rate_keys = ("cache_hit_input", "cache_miss_input", "output") if "cache_hit_input" in rates else ("input", "output")
    if any(_number(rates.get(key)) is None for key in rate_keys):
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
    return (round(cost / 1_000_000, 12) if _number(cost) is not None else None), inferred


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
                    canonical_id = canonical.duplicate_of_attempt_id or canonical.attempt_id
                    if canonical.duplicate_of_attempt_id:
                        canonical = db.scalar(select(ApiUsageAttemptEvent).where(
                            ApiUsageAttemptEvent.attempt_id == canonical_id,
                            ApiUsageAttemptEvent.event_kind == "finished",
                        )) or canonical
                    candidate = dict(
                        values,
                        duplicate_of_attempt_id=canonical_id,
                        tariff_estimated_cost_usd=None,
                        tool_tariff_estimated_cost_usd=None,
                    )
                    conflicts = conflicting_usage_fields(canonical.reported_usage, values.get("reported_usage"))
                    old_cost = _number(canonical.tariff_estimated_cost_usd)
                    new_cost = _number(values.get("tariff_estimated_cost_usd"))
                    roots = {match.duplicate_of_attempt_id or match.attempt_id for match in matches}
                    if len(roots) > 1 or conflicts or (old_cost is not None and new_cost is not None and old_cost != new_cost):
                        inferred = dict(values.get("inferred_usage") or {})
                        coverage = dict(inferred.get("coverage") or {})
                        coverage.update(
                            cost_status="ambiguous", cost_reason="conflicting_provider_identity",
                            conflicting_fields=sorted(set(coverage.get("conflicting_fields", [])) | set(conflicts)),
                        )
                        candidate["inferred_usage"] = {**inferred, "coverage": coverage}
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
        self._response_seen = False
        self._usage_sources: set[str] = set()
        self._malformed_usage_fields: set[str] = set()
        self._conflicting_usage_fields: set[str] = set()

    def __enter__(self):
        if self.context:
            self.context.last_attempt["attempt_id"] = self.values["attempt_id"]
        self._update_coverage()
        _persist_attempt(self.values)
        self._start = perf_counter()
        return self

    def observe(self, response: object, *, source: str = "response") -> None:
        self._response_seen = True
        # Usage is independent of optional identity/choice/result metadata.
        self._observe_usage(response, source=source)
        try:
            self._observe_response(response)
        except Exception:
            # SDK metadata evolves independently of the business response API.
            # An unexpected telemetry field must not fail a successful request.
            logger.warning("API usage metadata could not be read: attempt=%s", self.values["attempt_id"])

    def _observe_usage(self, response: object, *, source: str) -> None:
        try:
            usage, malformed, conflicts = extract_usage(response)
            self._malformed_usage_fields.update(malformed)
            conflicts.update(conflicting_usage_fields(self.values.get("reported_usage"), usage, cumulative=True))
            self._conflicting_usage_fields.update(conflicts)
            if usage is not None or malformed:
                self._usage_sources.add(source)
            if usage is not None:
                usage = _merge_usage(self.values.get("reported_usage"), usage)
                # A contradictory snapshot must not silently reuse an earlier
                # field or infer a cache split from the rejected observation.
                for field in self._conflicting_usage_fields:
                    path = field.split(".")
                    target = usage if len(path) == 1 else usage.get(path[0], {})
                    target[path[-1]] = None
                self.values["reported_usage"] = usage
                pricing_fields = {"input_tokens", "output_tokens"}
                rates = self.values.get("tariff_rates")
                if isinstance(rates, dict) and "cache_hit_input" in rates:
                    pricing_fields.update({"cache_read_input_tokens", "cache_miss_input_tokens"})
                invalid_pricing_fields = self._conflicting_usage_fields | {
                    field for field in self._malformed_usage_fields if usage.get(field) is None
                }
                cost, inferred = (None, None) if pricing_fields & invalid_pricing_fields else _estimate(usage, rates)
                self.values["tariff_estimated_cost_usd"] = cost
                self.values["inferred_usage"] = inferred
        except Exception:
            self._malformed_usage_fields.add("usage")
            logger.warning("API usage metadata could not be read: attempt=%s", self.values["attempt_id"])

    def _update_coverage(self) -> None:
        values = self.values
        usage = values.get("reported_usage")
        if has_reported_usage(usage):
            usage_status = "reported"
        elif self._malformed_usage_fields or self._conflicting_usage_fields:
            usage_status = "malformed"
        else:
            usage_status = "omitted" if self._response_seen else "unavailable"
        if values.get("tariff_estimated_cost_usd") is not None:
            cost_status, reason = "estimated_token_only", "listed_token_tariff"
        elif usage_status != "reported":
            cost_status, reason = "unavailable", f"usage_{usage_status}"
        elif not values.get("tariff_rates"):
            cost_status, reason = "unpriced", "tariff_unavailable"
        elif usage.get("input_tokens") is None or usage.get("output_tokens") is None:
            cost_status, reason = "unavailable", "required_token_counts_missing"
        else:
            cost_status, reason = "unavailable", "invalid_tariff_or_usage"
        values["inferred_usage"] = {
            **(values.get("inferred_usage") or {}),
            "coverage": {
                "version": 1, "usage_status": usage_status,
                "usage_sources": sorted(self._usage_sources),
                "malformed_fields": sorted(self._malformed_usage_fields),
                "conflicting_fields": sorted(self._conflicting_usage_fields),
                "cost_status": cost_status, "cost_reason": reason,
            },
        }

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

    def __exit__(self, exc_type, exc, traceback):
        if exc is not None:
            values = self.values
            # Read only available SDK metadata; never fetch, decode a raw body,
            # invoke response.json(), or serialize an exception to find usage.
            self._observe_usage(exc, source="exception")
            response = _attr(exc, "response")
            if response is not None:
                self.observe(response, source="exception_response")
            for name in ("body", "details"):
                payload = _attr(exc, name)
                if isinstance(payload, Mapping):
                    self._response_seen = True
                    self._observe_usage(payload, source=f"exception_{name}")
            values["status"] = "cancelled" if not isinstance(exc, Exception) or exc.__class__.__name__ in {"CancelledError", "SoftTimeLimitExceeded"} else "error"
            values["error_type"] = exc.__class__.__name__[:128]
            status = _first(exc, "status_code", "http_status", "code")
            if isinstance(status, int):
                values["http_status"] = status
            request_id = _text(_attr(exc, "request_id"), 255)
            if request_id:
                values["provider_request_id"] = request_id
                values["request_dedupe_key"] = content_hash([values["actual_provider"], "request", request_id])
        else:
            self.values["status"] = "success"
        if self.values.get("tariff_estimated_cost_usd") is None:
            # Unpriced evidence must not claim the charge identity and suppress
            # a later priced delivery. Retain raw provider IDs on every event.
            self.values["request_dedupe_key"] = None
            self.values["response_dedupe_key"] = None
        self.values["event_id"] = str(uuid4())
        self.values["event_kind"] = "finished"
        self.values["finished_at"] = datetime.now(UTC)
        self.values["latency_ms"] = max(0.0, (perf_counter() - self._start) * 1000)
        self._update_coverage()
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
