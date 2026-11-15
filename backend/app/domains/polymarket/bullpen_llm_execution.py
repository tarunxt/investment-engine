from __future__ import annotations

from collections import defaultdict
import concurrent.futures
from dataclasses import dataclass, field
from datetime import UTC, datetime
import hashlib
import json
import math
import random
import re
import threading
import time
from typing import Any, Literal

from pydantic import ValidationError

from app.domains.ai_providers.base import (
    AIProviderResponse,
    ProviderCallError,
    build_provider_call_error,
)
from app.domains.ai_providers.factory import ProviderFactory
from app.domains.polymarket.event_preflight import (
    detect_stale_fact,
    prepare_polymarket_event_context,
)
from app.domains.polymarket.stage2_models import (
    Stage2ProviderMarketOutput,
    first_present_mapping_value,
)
from app.domains.polymarket_auto_live.schemas import BullpenAutoLiveLlmOutput
from app.domains.runs.schemas import (
    BullpenLlmExecutionMode,
    BullpenLlmExecutionOptions,
    PolymarketEventQuestionPayload,
    PolymarketEventRunContext,
    PreparedPolymarketEventContext,
)

BULLPEN_LLM_DEFAULT_EXECUTION_MODE: BullpenLlmExecutionMode = "chunked_parallel"
BULLPEN_LLM_DEFAULT_EVENTS_PER_PROMPT = 20
BULLPEN_LLM_MIN_EVENTS_PER_PROMPT = 1
BULLPEN_LLM_MAX_EVENTS_PER_PROMPT = 100
BULLPEN_LLM_MAX_CONCURRENT_REQUESTS = 6
BULLPEN_LLM_REQUEST_TIMEOUT_SECONDS = 240
BULLPEN_LLM_MAX_REQUEST_ATTEMPTS = 3
BULLPEN_LLM_MAX_RECOVERY_BATCHES = 2
DEFAULT_PROVIDER_CONCURRENCY_LIMIT = 2
DEFAULT_BULLPEN_PROMPT_BUDGET_CHARS = 90_000
PROMPT_BUDGET_CHARS_BY_PROVIDER = {
    "openai": 110_000,
    "gemini": 110_000,
    "deepseek": 100_000,
    "anthropic": 80_000,
}
REQUEST_RETRYABLE_PATTERNS = (
    re.compile(r"\b429\b"),
    re.compile(r"\b5\d\d\b"),
    re.compile(r"rate limit", re.I),
    re.compile(r"timeout|timed out", re.I),
    re.compile(r"temporar", re.I),
    re.compile(r"connection", re.I),
    re.compile(r"network", re.I),
    re.compile(r"try again", re.I),
)
REQUEST_NON_RETRYABLE_PATTERNS = (
    re.compile(r"\b401\b"),
    re.compile(r"\b403\b"),
    re.compile(r"auth", re.I),
    re.compile(r"permission", re.I),
    re.compile(r"invalid model", re.I),
    re.compile(r"model not found", re.I),
    re.compile(r"project access denied", re.I),
    re.compile(r"unsupported", re.I),
    re.compile(r"bad request", re.I),
)
DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE = """[STAGE2_SHARED_EVIDENCE_ONLY]
You are estimating Polymarket YES/NO probabilities from a single shared evidence packet.

Each input row contains an `event_id` and a canonical `stage2_context`. Use only that structured context.
Do not browse. Do not add outside evidence. Treat Polymarket AI-generated market context as background only.
Use the exact resolution rules, the deterministic deadline fields, and the structured evidence packet as the source of truth.
Current market odds are a weak prior, not independent evidence.

Output requirements:
- Return strict JSON only.
- Return one row per expected `event_id`.
- Use `event_id` as the primary key.
- Do not skip events.
- Do not invent evidence or probabilities.
- Preserve valid 0/100 outcomes when the rules and evidence already settle the market.
- If only one side is known, return the complement for the other side.
- Write all three commentary fields for every event. Keep `preflight_commentary` limited to the Preflight Evidence Block/canonical market context, keep `internet_search_commentary` limited to the supplied searched claims and sources, then make `final_conclusion` explicitly reconcile those two analyses.

Schema:
{
  "markets": [
    {
      "event_id": "stable-event-id",
      "question_id": "question-id",
      "market_id": "market-id",
      "yes_definition": "exact YES resolution meaning",
      "deadline_utc": "2026-07-14T12:00:00+00:00",
      "resolution_timezone": "Asia/Riyadh",
      "hours_remaining": 4.25,
      "evidence_status": "insufficient|weak|moderate|strong|criteria_satisfied",
      "event_state": "already_occurred|not_confirmed|scheduled|preparatory|conflicting|unknown",
      "llm_yes_odds": 42.25,
      "llm_no_odds": 57.75,
      "confidence": "Low|Medium|High",
      "key_evidence_source_ids": ["S1", "S3"],
      "red_flags": ["short caveat"],
      "preflight_commentary": "Commentary based only on rules, deadline, market fields, and the Preflight Evidence Block",
      "internet_search_commentary": "Commentary based only on the supplied internet-search evidence packet and cited source IDs",
      "final_conclusion": "Final conclusion reconciling the previous two commentaries and supporting the probability",
      "rationale": "Same text as final_conclusion for backward compatibility"
    }
  ]
}

Selected questions:
{{SELECTED_QUESTIONS}}"""

_PROVIDER_SEMAPHORE_LOCK = threading.Lock()
_PROVIDER_SEMAPHORES: dict[str, threading.BoundedSemaphore] = {}


def _provider_semaphore(provider_name: str) -> threading.BoundedSemaphore:
    key = provider_name.strip().lower()
    with _PROVIDER_SEMAPHORE_LOCK:
        if key not in _PROVIDER_SEMAPHORES:
            _PROVIDER_SEMAPHORES[key] = threading.BoundedSemaphore(
                value=DEFAULT_PROVIDER_CONCURRENCY_LIMIT
            )
        return _PROVIDER_SEMAPHORES[key]


@dataclass(frozen=True)
class PreparedBullpenLlmEvent:
    event_id: str
    question_payload: PolymarketEventQuestionPayload
    original_index: int
    aliases: dict[str, str | None]
    estimated_chars: int
    question_runtime: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class BullpenLlmBatch:
    id: str
    event_ids: list[str]
    estimated_chars: int
    recovery_of_batch_id: str | None = None
    recovery_attempt: int = 0


@dataclass(frozen=True)
class BullpenLlmExecutionPlan:
    execution_mode: BullpenLlmExecutionMode
    batches: list[BullpenLlmBatch]
    event_count: int
    events_per_prompt: int
    expected_primary_request_count: int
    safe_prompt_budget_chars: int | None = None


@dataclass
class ParsedBullpenMarketRow:
    event_id: str
    record: dict[str, Any]
    question_ref: str | None
    question_id: str | None
    market_id: str | None
    question: str | None
    llm_yes_odds: float | None
    llm_no_odds: float | None
    yes_definition: str | None
    deadline_et: str | None
    deadline_utc: str | None
    resolution_timezone: str | None
    hours_remaining: float | None
    evidence_status: str | None
    event_state: str | None
    confidence: str | None
    key_evidence: list[str]
    key_evidence_source_ids: list[str]
    red_flags: list[str]
    rationale: str | None
    preflight_commentary: str | None = None
    internet_search_commentary: str | None = None
    final_conclusion: str | None = None


@dataclass
class ParsedBullpenBatchResponse:
    rows_by_event_id: dict[str, ParsedBullpenMarketRow] = field(default_factory=dict)
    missing_event_ids: list[str] = field(default_factory=list)
    invalid_event_errors: dict[str, str] = field(default_factory=dict)
    duplicate_event_ids: list[str] = field(default_factory=list)
    unexpected_rows: list[dict[str, Any]] = field(default_factory=list)
    raw_markets: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class BullpenProviderBatchCall:
    provider: str
    model: str
    response: AIProviderResponse | None
    attempts: int
    retry_count: int
    elapsed_seconds: float
    error: ProviderCallError | None = None
    actual_model: str | None = None


@dataclass
class BullpenLlmEventProviderResult:
    event_id: str
    provider: str
    model: str
    status: Literal[
        "success",
        "recovered",
        "provider_failed",
        "provider_unavailable",
        "timed_out",
        "invalid_json",
        "invalid_schema",
        "missing_event",
        "evidence_blocked",
        "circuit_open",
        "cancelled",
    ]
    row: ParsedBullpenMarketRow | None = None
    error: str | None = None
    invalid_reason: str | None = None
    stale_fact_detected: bool = False
    stale_fact_reason: str | None = None
    web_search_used: bool = False
    web_search_queries: list[str] = field(default_factory=list)
    web_sources: list[str] = field(default_factory=list)
    attempts: int = 1
    batch_id: str | None = None
    diagnostic: dict[str, Any] | None = None


@dataclass
class BullpenLlmBatchRuntimeMetadata:
    batch_id: str
    provider: str
    model: str
    event_ids: list[str]
    event_count: int
    status: str
    attempts: int
    elapsed_seconds: float
    error_summary: str | None = None
    error_category: str | None = None
    error_details: dict[str, Any] | None = None
    recovery_attempt: int = 0
    recovered_from_batch_id: str | None = None


def _build_batch_diagnostic_metadata(
    *,
    category: str,
    safe_message: str | None,
    provider_name: str,
    model_name: str,
    actual_model: str | None = None,
    batch_id: str | None = None,
    attempts: int | None = None,
    elapsed_seconds: float | None = None,
    recovery_attempt: int | None = None,
    recovered_from_batch_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "category": category,
        "safe_message": safe_message
        or "LLM batch did not produce a usable terminal result.",
        "provider": provider_name,
        "requested_model": model_name,
        "actual_model": actual_model,
        "batch_id": batch_id,
        "attempts": attempts,
        "elapsed_seconds": elapsed_seconds,
        "recovery_attempt": recovery_attempt,
        "recovered_from_batch_id": recovered_from_batch_id,
    }
    if extra:
        metadata.update(extra)
    return metadata


@dataclass
class BullpenLlmTargetExecutionResult:
    provider: str
    model: str
    response_text: str
    runtime_metadata: dict[str, Any]
    event_results: dict[str, BullpenLlmEventProviderResult]
    batch_metadata: list[BullpenLlmBatchRuntimeMetadata]
    status: Literal["completed", "partial", "failed"]
    tokens_in: int
    tokens_out: int
    estimated_cost: float
    web_search_used: bool
    web_search_queries: list[str]
    web_sources: list[str]
    primary_request_count: int
    retry_request_count: int
    recovery_batch_count: int
    recovered_event_count: int
    failed_event_count: int
    blocked_event_count: int
    invalid_event_count: int
    max_observed_concurrency: int
    prompt_size_estimates: list[dict[str, Any]]


def build_bullpen_prompt_template_hash(template: str) -> str:
    return hashlib.sha256(template.encode("utf-8")).hexdigest()[:16]


def normalize_bullpen_execution_options(
    options: BullpenLlmExecutionOptions | None,
    *,
    target_count: int,
    prompt_template: str,
) -> BullpenLlmExecutionOptions:
    raw = options.model_dump(mode="json") if options is not None else {}
    normalized = BullpenLlmExecutionOptions.model_validate(
        {
            "execution_mode": raw.get("execution_mode")
            or BULLPEN_LLM_DEFAULT_EXECUTION_MODE,
            "events_per_prompt": raw.get("events_per_prompt")
            or BULLPEN_LLM_DEFAULT_EVENTS_PER_PROMPT,
            "max_concurrent_requests": raw.get("max_concurrent_requests")
            or BULLPEN_LLM_MAX_CONCURRENT_REQUESTS,
            "target_count": max(1, target_count),
            "prompt_template_hash": raw.get("prompt_template_hash")
            or build_bullpen_prompt_template_hash(prompt_template),
        }
    )
    return normalized


def derive_target_request_concurrency(
    *,
    max_concurrent_requests: int,
    target_count: int,
) -> int:
    if target_count <= 1:
        return max(1, max_concurrent_requests)
    return max(1, math.floor(max_concurrent_requests / max(1, target_count)))


def prompt_budget_chars_for_provider(provider_name: str) -> int:
    return PROMPT_BUDGET_CHARS_BY_PROVIDER.get(
        provider_name.strip().lower(),
        DEFAULT_BULLPEN_PROMPT_BUDGET_CHARS,
    )


def _normalize_lookup_value(value: str | None) -> str | None:
    if not value:
        return None
    normalized = re.sub(r"\s+", " ", value).strip().lower()
    return normalized or None


def _stable_event_id(question: PolymarketEventQuestionPayload, index: int) -> str:
    for value in (
        question.question_id,
        question.market_id,
        question.question_ref,
        question.slug,
        question.market_url,
    ):
        normalized = _normalize_lookup_value(value)
        if normalized:
            return normalized
    return f"event-{index + 1}"


def build_prepared_bullpen_events(
    prepared_context: PreparedPolymarketEventContext,
) -> list[PreparedBullpenLlmEvent]:
    runtime_by_question_id = (
        prepared_context.runtime_metadata.get("question_runtime")
        if isinstance(prepared_context.runtime_metadata, dict)
        else None
    )
    runtime_by_question_id = (
        runtime_by_question_id if isinstance(runtime_by_question_id, dict) else {}
    )
    prepared_events: list[PreparedBullpenLlmEvent] = []
    seen_event_ids: set[str] = set()

    for index, question in enumerate(prepared_context.question_payload):
        event_id = _stable_event_id(question, index)
        if event_id in seen_event_ids:
            event_id = f"{event_id}::{index + 1}"
        seen_event_ids.add(event_id)
        question_payload_json = question.model_dump(mode="json")
        prepared_events.append(
            PreparedBullpenLlmEvent(
                event_id=event_id,
                question_payload=question,
                original_index=index,
                aliases={
                    "question_id": question.question_id,
                    "market_id": question.market_id,
                    "question_ref": question.question_ref,
                    "slug": question.slug,
                    "market_url": question.market_url,
                    "question": question.question,
                },
                estimated_chars=len(
                    json.dumps(question_payload_json, ensure_ascii=False)
                ),
                question_runtime=(
                    dict(runtime_by_question_id.get(question.question_id) or {})
                    if question.question_id in runtime_by_question_id
                    else {
                        "question_ref": question.question_ref,
                        "question_id": question.question_id,
                        "question": question.question,
                        "web_search_used": False,
                        "web_search_queries": [],
                        "web_sources": [],
                        "evidence_block_used": bool(
                            (question.preflight_evidence_block or "").strip()
                        ),
                        "internet_verified": False,
                        "stale_fact_detected": False,
                        "invalid_reason": None,
                        "preflight_evidence_block": question.preflight_evidence_block,
                    }
                ),
            )
        )
    return prepared_events


def _build_prompt(
    template: str,
    question_payload: list[dict[str, Any]],
) -> str:
    selected_questions_json = json.dumps(
        question_payload,
        ensure_ascii=False,
        indent=2,
    )
    placeholder = "{{SELECTED_QUESTIONS}}"
    normalized_template = template.strip()
    has_stage2_context = any(
        isinstance(item, dict) and isinstance(item.get("stage2_context"), dict)
        for item in question_payload
    )
    if (
        has_stage2_context
        and "[stage2_shared_evidence_only]" not in normalized_template.lower()
    ):
        normalized_template = "[STAGE2_SHARED_EVIDENCE_ONLY]\n" f"{normalized_template}"
    if placeholder in normalized_template:
        return normalized_template.replace(placeholder, selected_questions_json)
    return f"{normalized_template}\n\nSelected questions:\n{selected_questions_json}"


def _prompt_payload_for_event(event: PreparedBullpenLlmEvent) -> dict[str, Any]:
    question = event.question_payload
    if question.stage2_context is not None:
        return {
            "event_id": event.event_id,
            "question_ref": question.question_ref,
            "question_id": question.question_id,
            "market_id": question.market_id,
            "condition_id": question.condition_id,
            "market_slug": question.market_slug,
            "event_slug": question.event_slug,
            "question": question.question,
            "preflight_evidence_block": question.preflight_evidence_block,
            "stage2_context": question.stage2_context.model_dump(mode="json"),
        }
    payload = question.model_dump(mode="json")
    payload["event_id"] = event.event_id
    return payload


def estimate_batch_prompt_size_chars(
    *,
    prompt_template: str,
    events: list[PreparedBullpenLlmEvent],
) -> int:
    return len(
        _build_prompt(
            prompt_template,
            [_prompt_payload_for_event(event) for event in events],
        )
    )


def estimate_batch_prompt_tokens(
    *,
    prompt_template: str,
    events: list[PreparedBullpenLlmEvent],
) -> int:
    # Coarse but stable cross-provider estimate used only for batching diagnostics.
    return max(
        1,
        math.ceil(
            estimate_batch_prompt_size_chars(
                prompt_template=prompt_template,
                events=events,
            )
            / 4
        ),
    )


def plan_bullpen_llm_execution(
    events: list[PreparedBullpenLlmEvent],
    *,
    execution_mode: BullpenLlmExecutionMode,
    events_per_prompt: int,
    safe_prompt_budget_chars: int | None = None,
    prompt_template: str,
) -> BullpenLlmExecutionPlan:
    if not events:
        return BullpenLlmExecutionPlan(
            execution_mode=execution_mode,
            batches=[],
            event_count=0,
            events_per_prompt=events_per_prompt,
            expected_primary_request_count=0,
            safe_prompt_budget_chars=safe_prompt_budget_chars,
        )

    if execution_mode == "single_combined":
        batch = BullpenLlmBatch(
            id="batch-001",
            event_ids=[event.event_id for event in events],
            estimated_chars=estimate_batch_prompt_size_chars(
                prompt_template=prompt_template,
                events=events,
            ),
        )
        return BullpenLlmExecutionPlan(
            execution_mode=execution_mode,
            batches=[batch],
            event_count=len(events),
            events_per_prompt=events_per_prompt,
            expected_primary_request_count=1,
            safe_prompt_budget_chars=safe_prompt_budget_chars,
        )

    batches: list[BullpenLlmBatch] = []
    current_events: list[PreparedBullpenLlmEvent] = []

    def flush_batch() -> None:
        if not current_events:
            return
        batches.append(
            BullpenLlmBatch(
                id=f"batch-{len(batches) + 1:03d}",
                event_ids=[event.event_id for event in current_events],
                estimated_chars=estimate_batch_prompt_size_chars(
                    prompt_template=prompt_template,
                    events=current_events,
                ),
            )
        )
        current_events.clear()

    for event in events:
        next_events = [*current_events, event]
        next_estimate = estimate_batch_prompt_size_chars(
            prompt_template=prompt_template,
            events=next_events,
        )
        exceeds_count = len(next_events) > events_per_prompt
        exceeds_budget = bool(
            safe_prompt_budget_chars
            and current_events
            and next_estimate > safe_prompt_budget_chars
        )
        if exceeds_count or exceeds_budget:
            flush_batch()
            current_events.append(event)
            continue
        current_events.append(event)
    flush_batch()

    return BullpenLlmExecutionPlan(
        execution_mode=execution_mode,
        batches=batches,
        event_count=len(events),
        events_per_prompt=events_per_prompt,
        expected_primary_request_count=len(batches),
        safe_prompt_budget_chars=safe_prompt_budget_chars,
    )


def _extract_json_value(text: str) -> object:
    trimmed = (text or "").strip()
    if not trimmed:
        raise ValueError("LLM returned an empty response.")

    candidates: list[str] = []

    def register(candidate: str | None) -> None:
        if not candidate:
            return
        normalized = candidate.strip()
        if normalized and normalized not in candidates:
            candidates.append(normalized)

    for match in re.finditer(
        r"```(?:json)?\s*([\s\S]*?)```", trimmed, flags=re.IGNORECASE
    ):
        register(match.group(1))
    register(trimmed)

    object_start = trimmed.find("{")
    object_end = trimmed.rfind("}")
    if object_start >= 0 and object_end > object_start:
        register(trimmed[object_start : object_end + 1])

    array_start = trimmed.find("[")
    array_end = trimmed.rfind("]")
    if array_start >= 0 and array_end > array_start:
        register(trimmed[array_start : array_end + 1])

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    raise ValueError("LLM response was not valid JSON.")


def _extract_markets(parsed: object) -> list[dict[str, Any]]:
    if isinstance(parsed, list):
        return [item for item in parsed if isinstance(item, dict)]
    if not isinstance(parsed, dict):
        return []
    for key in ("markets", "questions", "predictions", "results", "items"):
        value = parsed.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    nested = parsed.get("content")
    if isinstance(nested, dict):
        return _extract_markets(nested)
    return []


def _read_str(record: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _read_str_list(record: dict[str, Any], *keys: str) -> list[str]:
    for key in keys:
        value = record.get(key)
        if isinstance(value, list):
            result = [str(item).strip() for item in value if str(item).strip()]
            if result:
                return result
        if isinstance(value, str) and value.strip():
            return [value.strip()]
    return []


def _read_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.replace("%", "").replace("$", "").replace(",", "").strip()
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _normalize_odds_pair(
    yes_value: float | None,
    no_value: float | None,
) -> tuple[float | None, float | None]:
    yes = yes_value
    no = no_value
    if yes is not None and no is None:
        no = 100 - yes
    elif no is not None and yes is None:
        yes = 100 - no
    if yes is not None:
        yes = max(0, min(100, round(yes, 2)))
    if no is not None:
        no = max(0, min(100, round(no, 2)))
    return yes, no


def _build_identifier_maps(
    events: list[PreparedBullpenLlmEvent],
) -> dict[str, dict[str, str]]:
    raw_maps: dict[str, dict[str, list[str]]] = {
        "question_id": defaultdict(list),
        "market_id": defaultdict(list),
        "question_ref": defaultdict(list),
        "slug": defaultdict(list),
        "market_url": defaultdict(list),
        "question": defaultdict(list),
    }
    for event in events:
        for field_name, value in event.aliases.items():
            normalized = _normalize_lookup_value(value)
            if not normalized:
                continue
            raw_maps[field_name][normalized].append(event.event_id)
    resolved: dict[str, dict[str, str]] = {}
    for field_name, field_values in raw_maps.items():
        resolved[field_name] = {
            normalized: event_ids[0]
            for normalized, event_ids in field_values.items()
            if len(set(event_ids)) == 1
        }
    return resolved


def _match_event_id(
    record: dict[str, Any],
    identifier_maps: dict[str, dict[str, str]],
) -> str | None:
    identifier_fields = (
        ("question_id", ("question_id", "questionId")),
        ("market_id", ("market_id", "marketId")),
        ("question_ref", ("question_ref", "questionRef")),
        ("slug", ("slug",)),
        ("market_url", ("market_url", "marketUrl")),
        ("question", ("question",)),
    )
    for field_name, keys in identifier_fields:
        normalized = _normalize_lookup_value(_read_str(record, *keys))
        if normalized and normalized in identifier_maps[field_name]:
            return identifier_maps[field_name][normalized]
    return None


def parse_bullpen_batch_response(
    response_text: str,
    *,
    events: list[PreparedBullpenLlmEvent],
) -> ParsedBullpenBatchResponse:
    parsed = _extract_json_value(response_text)
    markets = _extract_markets(parsed)
    identifier_maps = _build_identifier_maps(events)
    event_by_id = {event.event_id: event for event in events}
    response = ParsedBullpenBatchResponse(raw_markets=markets)

    if not markets:
        response.missing_event_ids = [event.event_id for event in events]
        return response

    for record in markets:
        normalized_event_id = _normalize_lookup_value(
            _read_str(record, "event_id", "eventId")
        )
        matched_event_id = None
        if normalized_event_id and normalized_event_id in event_by_id:
            matched_event_id = normalized_event_id
        if matched_event_id is None:
            matched_event_id = _match_event_id(record, identifier_maps)
        if not matched_event_id:
            response.unexpected_rows.append(record)
            continue
        if matched_event_id in response.rows_by_event_id:
            response.duplicate_event_ids.append(matched_event_id)
            continue

        yes, no = _normalize_odds_pair(
            _read_number(
                first_present_mapping_value(
                    record,
                    "llm_yes_odds",
                    "llmYesOdds",
                    "yes_odds",
                    "yesOdds",
                    "yes_probability",
                    "prob_yes",
                )
            ),
            _read_number(
                first_present_mapping_value(
                    record,
                    "llm_no_odds",
                    "llmNoOdds",
                    "no_odds",
                    "noOdds",
                    "no_probability",
                    "prob_no",
                )
            ),
        )

        if yes is None and no is None:
            response.invalid_event_errors[matched_event_id] = (
                "Model returned a row for this event but did not include usable YES/NO odds."
            )
            continue

        event = event_by_id[matched_event_id]
        try:
            validated_row = Stage2ProviderMarketOutput.model_validate(
                {
                    "event_id": matched_event_id,
                    "question_id": _read_str(record, "question_id", "questionId")
                    or event.question_payload.question_id,
                    "market_id": _read_str(record, "market_id", "marketId")
                    or event.question_payload.market_id,
                    "yes_definition": _read_str(
                        record, "yes_definition", "yesDefinition"
                    ),
                    "deadline_utc": _read_str(record, "deadline_utc", "deadlineUtc"),
                    "resolution_timezone": _read_str(
                        record,
                        "resolution_timezone",
                        "resolutionTimezone",
                    ),
                    "hours_remaining": first_present_mapping_value(
                        record,
                        "hours_remaining",
                        "hoursRemaining",
                    ),
                    "evidence_status": _read_str(
                        record,
                        "evidence_status",
                        "evidenceStatus",
                    ),
                    "event_state": _read_str(record, "event_state", "eventState"),
                    "llm_yes_odds": yes,
                    "llm_no_odds": no,
                    "confidence": _read_str(record, "confidence"),
                    "key_evidence_source_ids": _read_str_list(
                        record,
                        "key_evidence_source_ids",
                        "keyEvidenceSourceIds",
                    ),
                    "red_flags": _read_str_list(record, "red_flags", "redFlags"),
                    "preflight_commentary": _read_str(record, "preflight_commentary", "preflightCommentary"),
                    "internet_search_commentary": _read_str(record, "internet_search_commentary", "internetSearchCommentary"),
                    "final_conclusion": _read_str(record, "final_conclusion", "finalConclusion"),
                    "rationale": _read_str(
                        record,
                        "rationale",
                        "reasoning",
                        "notes",
                        "note",
                        "explanation",
                        "summary",
                    ),
                }
            )
        except ValidationError as exc:
            response.invalid_event_errors[matched_event_id] = str(exc).splitlines()[0]
            continue
        response.rows_by_event_id[matched_event_id] = ParsedBullpenMarketRow(
            event_id=matched_event_id,
            record=record,
            question_ref=_read_str(record, "question_ref", "questionRef")
            or event.question_payload.question_ref,
            question_id=_read_str(record, "question_id", "questionId")
            or event.question_payload.question_id,
            market_id=_read_str(record, "market_id", "marketId")
            or event.question_payload.market_id,
            question=_read_str(record, "question") or event.question_payload.question,
            llm_yes_odds=validated_row.llm_yes_odds,
            llm_no_odds=validated_row.llm_no_odds,
            yes_definition=validated_row.yes_definition,
            deadline_et=_read_str(record, "deadline_et", "deadlineEt"),
            deadline_utc=validated_row.deadline_utc,
            resolution_timezone=validated_row.resolution_timezone,
            hours_remaining=validated_row.hours_remaining,
            evidence_status=validated_row.evidence_status,
            event_state=validated_row.event_state,
            confidence=validated_row.confidence,
            key_evidence=_read_str_list(record, "key_evidence", "keyEvidence"),
            key_evidence_source_ids=validated_row.key_evidence_source_ids,
            red_flags=validated_row.red_flags,
            preflight_commentary=validated_row.preflight_commentary,
            internet_search_commentary=validated_row.internet_search_commentary,
            final_conclusion=validated_row.final_conclusion,
            rationale=validated_row.rationale or validated_row.final_conclusion,
        )

    response.missing_event_ids = [
        event.event_id
        for event in events
        if event.event_id not in response.rows_by_event_id
        and event.event_id not in response.invalid_event_errors
    ]
    return response


def _call_provider_once_with_timeout(
    provider_name: str,
    model_name: str,
    prompt: str,
) -> AIProviderResponse:
    provider = ProviderFactory.create(provider_name)
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    semaphore = _provider_semaphore(provider_name)
    semaphore.acquire()
    try:
        future = executor.submit(provider.generate, prompt=prompt, model=model_name)
        return future.result(timeout=BULLPEN_LLM_REQUEST_TIMEOUT_SECONDS)
    except concurrent.futures.TimeoutError as exc:
        future.cancel()
        raise ProviderCallError(
            provider=provider_name,
            requested_model=model_name,
            execution_phase="request",
            safe_message=(
                f"{provider_name}/{model_name} timed out after "
                f"{BULLPEN_LLM_REQUEST_TIMEOUT_SECONDS} seconds"
            ),
            retryable=True,
        ) from exc
    finally:
        semaphore.release()
        executor.shutdown(wait=False, cancel_futures=True)


def _is_retryable_request_error(error: Exception) -> bool:
    message = str(error).strip()
    if not message:
        return False
    if any(pattern.search(message) for pattern in REQUEST_NON_RETRYABLE_PATTERNS):
        return False
    return any(pattern.search(message) for pattern in REQUEST_RETRYABLE_PATTERNS)


def execute_provider_batch_call(
    *,
    provider_name: str,
    model_name: str,
    prompt: str,
) -> BullpenProviderBatchCall:
    health = ProviderFactory.validate_target(provider_name, model_name)
    if not health.available:
        error = ProviderCallError(
            provider=provider_name,
            requested_model=model_name,
            actual_model=None,
            execution_phase="capability_check",
            safe_message=health.reason or "Provider target is unavailable.",
            retryable=False,
        )
        return BullpenProviderBatchCall(
            provider=provider_name,
            model=model_name,
            response=None,
            attempts=1,
            retry_count=0,
            elapsed_seconds=0.0,
            error=error,
            actual_model=None,
        )
    started_at = time.monotonic()
    attempts = 0
    retry_count = 0
    last_error: ProviderCallError | None = None
    response: AIProviderResponse | None = None

    while attempts < BULLPEN_LLM_MAX_REQUEST_ATTEMPTS:
        attempts += 1
        try:
            response = _call_provider_once_with_timeout(
                provider_name,
                model_name,
                prompt,
            )
            break
        except Exception as exc:  # pragma: no cover - exercised via tests with stubs
            retryable = (
                exc.retryable
                if isinstance(exc, ProviderCallError)
                else _is_retryable_request_error(exc)
            )
            last_error = (
                exc
                if isinstance(exc, ProviderCallError)
                else build_provider_call_error(
                    provider=provider_name,
                    requested_model=model_name,
                    execution_phase="request",
                    error=exc,
                    retryable=retryable,
                    attempt=attempts,
                    elapsed_seconds=round(time.monotonic() - started_at, 3),
                )
            )
            if attempts >= BULLPEN_LLM_MAX_REQUEST_ATTEMPTS or not retryable:
                break
            retry_count += 1
            retry_after = last_error.retry_after_seconds if last_error else None
            backoff_seconds = (
                retry_after
                if isinstance(retry_after, (int, float)) and retry_after > 0
                else min(12.0, (2 ** (attempts - 1)) + random.uniform(0.2, 0.8))
            )
            time.sleep(backoff_seconds)

    return BullpenProviderBatchCall(
        provider=provider_name,
        model=model_name,
        response=response,
        attempts=attempts,
        retry_count=retry_count,
        elapsed_seconds=round(time.monotonic() - started_at, 3),
        error=last_error if last_error is not None and response is None else None,
        actual_model=response.model if response is not None else None,
    )


def _build_batch_prompt(
    *,
    prompt_template: str,
    events: list[PreparedBullpenLlmEvent],
) -> str:
    return _build_prompt(
        prompt_template,
        [_prompt_payload_for_event(event) for event in events],
    )


def _merge_unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    merged: list[str] = []
    for value in values:
        normalized = value.strip()
        key = normalized.lower()
        if not normalized or key in seen:
            continue
        seen.add(key)
        merged.append(normalized)
    return merged


def _build_question_runtime_entry(
    *,
    context: PolymarketEventRunContext,
    event: PreparedBullpenLlmEvent,
    row: ParsedBullpenMarketRow | None,
    provider_name: str,
    batch_call: BullpenProviderBatchCall | None,
    invalid_reason: str | None = None,
    error_reason: str | None = None,
) -> tuple[dict[str, Any], bool, str | None]:
    question_runtime = dict(event.question_runtime)
    model_web_search_used = bool(
        batch_call and batch_call.response and batch_call.response.web_search_used
    )
    model_web_search_queries = (
        batch_call.response.web_search_queries
        if batch_call and batch_call.response
        else []
    )
    model_web_sources = (
        batch_call.response.web_sources if batch_call and batch_call.response else []
    )
    question_runtime["web_search_used"] = bool(
        question_runtime.get("web_search_used") or model_web_search_used
    )
    question_runtime["web_search_queries"] = _merge_unique_strings(
        [
            *(question_runtime.get("web_search_queries") or []),
            *model_web_search_queries,
        ]
    )
    question_runtime["web_sources"] = _merge_unique_strings(
        [*(question_runtime.get("web_sources") or []), *model_web_sources]
    )
    question_runtime["preflight_evidence_block"] = (
        question_runtime.get("preflight_evidence_block")
        or event.question_payload.preflight_evidence_block
    )
    stale_fact_detected = False
    stale_fact_reason = None
    if row is not None:
        stale_fact_detected, stale_fact_reason = detect_stale_fact(
            question_runtime.get("preflight_evidence_block"),
            row.rationale,
        )
    if stale_fact_detected:
        question_runtime["invalid_reason"] = stale_fact_reason
    elif invalid_reason:
        question_runtime["invalid_reason"] = invalid_reason
    elif error_reason:
        question_runtime["invalid_reason"] = error_reason
    elif (
        context.evidence_options.require_fresh_internet_evidence
        and not bool(question_runtime.get("web_search_used"))
        and not bool(question_runtime.get("evidence_block_used"))
    ):
        question_runtime["invalid_reason"] = (
            "Fresh internet evidence was required, but no verified evidence block or web usage was recorded."
        )
    else:
        question_runtime["invalid_reason"] = None
    question_runtime["stale_fact_detected"] = stale_fact_detected
    question_runtime["internet_verified"] = bool(
        question_runtime.get("internet_verified")
        or question_runtime["web_search_used"]
        or question_runtime["web_sources"]
        or question_runtime.get("evidence_block_used")
    )
    if event.question_payload.stage2_context is not None:
        question_runtime["stage2_context"] = (
            event.question_payload.stage2_context.model_dump(mode="json")
        )
    if event.question_payload.evidence_packet_v2 is not None:
        question_runtime["evidence_packet_v2"] = (
            event.question_payload.evidence_packet_v2.model_dump(mode="json")
        )
    return question_runtime, stale_fact_detected, stale_fact_reason


def _serialize_final_market_row(
    event: PreparedBullpenLlmEvent,
    event_result: BullpenLlmEventProviderResult | None,
) -> dict[str, Any]:
    row = event_result.row if event_result is not None else None
    rationale = None
    if row is not None:
        rationale = row.rationale
    if not rationale:
        rationale = (
            event_result.invalid_reason
            if event_result and event_result.invalid_reason
            else event_result.error if event_result and event_result.error else None
        )
    return {
        "event_id": event.event_id,
        "question_ref": (
            row.question_ref if row is not None else event.question_payload.question_ref
        ),
        "question_id": (
            row.question_id if row is not None else event.question_payload.question_id
        ),
        "market_id": (
            row.market_id if row is not None else event.question_payload.market_id
        ),
        "question": (
            row.question if row is not None else event.question_payload.question
        ),
        "yes_definition": row.yes_definition if row is not None else None,
        "deadline_et": (
            row.deadline_et if row is not None else event.question_payload.deadline_et
        ),
        "deadline_utc": row.deadline_utc if row is not None else None,
        "resolution_timezone": row.resolution_timezone if row is not None else None,
        "hours_remaining": (
            row.hours_remaining
            if row is not None
            else event.question_payload.hours_remaining
        ),
        "evidence_status": row.evidence_status if row is not None else None,
        "event_state": row.event_state if row is not None else None,
        "llm_yes_odds": row.llm_yes_odds if row is not None else None,
        "llm_no_odds": row.llm_no_odds if row is not None else None,
        "confidence": row.confidence if row is not None else None,
        "key_evidence": row.key_evidence if row is not None else [],
        "key_evidence_source_ids": (
            row.key_evidence_source_ids if row is not None else []
        ),
        "red_flags": row.red_flags if row is not None else [],
        "preflight_commentary": row.preflight_commentary if row is not None else None,
        "internet_search_commentary": row.internet_search_commentary if row is not None else None,
        "final_conclusion": row.final_conclusion if row is not None else rationale,
        "status": (
            event_result.status if event_result is not None else "provider_failed"
        ),
        "rationale": rationale,
    }


def execute_bullpen_llm_target(
    context: PolymarketEventRunContext,
    *,
    provider_name: str,
    model_name: str,
    prepared_context: PreparedPolymarketEventContext | None = None,
) -> BullpenLlmTargetExecutionResult:
    prepared_context = (
        prepared_context
        if prepared_context is not None
        else (
            context.prepared_context
            if context.prepared_context is not None
            else prepare_polymarket_event_context(context)
        )
    )
    prepared_events = build_prepared_bullpen_events(prepared_context)
    target_health = ProviderFactory.validate_target(provider_name, model_name)
    execution_options = normalize_bullpen_execution_options(
        context.execution_options,
        target_count=context.execution_options.target_count,
        prompt_template=context.prompt_template,
    )
    safe_prompt_budget_chars = prompt_budget_chars_for_provider(provider_name)
    plan = plan_bullpen_llm_execution(
        prepared_events,
        execution_mode=execution_options.execution_mode,
        events_per_prompt=execution_options.events_per_prompt,
        safe_prompt_budget_chars=(
            safe_prompt_budget_chars
            if execution_options.execution_mode == "chunked_parallel"
            else None
        ),
        prompt_template=context.prompt_template,
    )
    prompt_size_estimates = [
        {
            "batch_id": batch.id,
            "estimated_chars": batch.estimated_chars,
            "estimated_prompt_tokens": estimate_batch_prompt_tokens(
                prompt_template=context.prompt_template,
                events=[
                    event
                    for event in prepared_events
                    if event.event_id in batch.event_ids
                ],
            ),
            "event_count": len(batch.event_ids),
            "budget_chars": safe_prompt_budget_chars,
        }
        for batch in plan.batches
    ]
    execution_mode_reason: str | None = None
    if (
        execution_options.execution_mode == "single_combined"
        and plan.batches
        and plan.batches[0].estimated_chars > safe_prompt_budget_chars
    ):
        execution_mode_reason = (
            "Single combined prompt exceeded this target's safe prompt budget; "
            "automatically switched to Batched parallel for this provider."
        )
        execution_options = execution_options.model_copy(
            update={"execution_mode": "chunked_parallel"}
        )
        plan = plan_bullpen_llm_execution(
            prepared_events,
            execution_mode=execution_options.execution_mode,
            events_per_prompt=execution_options.events_per_prompt,
            safe_prompt_budget_chars=safe_prompt_budget_chars,
            prompt_template=context.prompt_template,
        )
        prompt_size_estimates = [
            {
                "batch_id": batch.id,
                "estimated_chars": batch.estimated_chars,
                "estimated_prompt_tokens": estimate_batch_prompt_tokens(
                    prompt_template=context.prompt_template,
                    events=[
                        event
                        for event in prepared_events
                        if event.event_id in batch.event_ids
                    ],
                ),
                "event_count": len(batch.event_ids),
                "budget_chars": safe_prompt_budget_chars,
            }
            for batch in plan.batches
        ]
    target_concurrency_limit = derive_target_request_concurrency(
        max_concurrent_requests=execution_options.max_concurrent_requests,
        target_count=execution_options.target_count,
    )

    event_lookup = {event.event_id: event for event in prepared_events}
    batch_metadata: list[BullpenLlmBatchRuntimeMetadata] = []
    event_results: dict[str, BullpenLlmEventProviderResult] = {}
    total_tokens_in = 0
    total_tokens_out = 0
    total_cost = 0.0
    retry_request_count = 0
    recovery_batch_count = 0
    max_observed_concurrency = 0
    circuit_open = False

    if not target_health.available:
        unavailable_error = ProviderCallError(
            provider=provider_name,
            requested_model=model_name,
            execution_phase="capability_check",
            safe_message=target_health.reason or "Provider target is unavailable.",
            retryable=False,
        )
        unavailable_diagnostic = unavailable_error.to_metadata()
        for event in prepared_events:
            event_results[event.event_id] = BullpenLlmEventProviderResult(
                event_id=event.event_id,
                provider=provider_name,
                model=model_name,
                status="provider_unavailable",
                error=unavailable_error.safe_message,
                attempts=1,
                diagnostic=unavailable_diagnostic,
            )
        batch_metadata = [
            BullpenLlmBatchRuntimeMetadata(
                batch_id="target-capability-check",
                provider=provider_name,
                model=model_name,
                event_ids=[event.event_id for event in prepared_events],
                event_count=len(prepared_events),
                status="failed",
                attempts=1,
                elapsed_seconds=0.0,
                error_summary=unavailable_error.safe_message,
                error_category=unavailable_error.execution_phase,
                error_details=unavailable_diagnostic,
            )
        ]
        runtime_metadata = _build_runtime_metadata(
            context=context,
            execution_options=execution_options,
            event_lookup=event_lookup,
            event_results=event_results,
            batch_metadata=batch_metadata,
            provider_name=provider_name,
            model_name=model_name,
            prompt_size_estimates=prompt_size_estimates,
            primary_request_count=0,
            retry_request_count=0,
            recovery_batch_count=0,
            max_observed_concurrency=0,
        )
        response_text = json.dumps(
            {
                "markets": [
                    _serialize_final_market_row(
                        event, event_results.get(event.event_id)
                    )
                    for event in sorted(
                        prepared_events, key=lambda item: item.original_index
                    )
                ]
            },
            ensure_ascii=False,
            indent=2,
        )
        return BullpenLlmTargetExecutionResult(
            provider=provider_name,
            model=model_name,
            response_text=response_text,
            runtime_metadata=runtime_metadata,
            event_results=event_results,
            batch_metadata=[],
            status="failed",
            tokens_in=0,
            tokens_out=0,
            estimated_cost=0.0,
            web_search_used=False,
            web_search_queries=[],
            web_sources=[],
            primary_request_count=0,
            retry_request_count=0,
            recovery_batch_count=0,
            recovered_event_count=0,
            failed_event_count=len(prepared_events),
            blocked_event_count=0,
            invalid_event_count=0,
            max_observed_concurrency=0,
            prompt_size_estimates=prompt_size_estimates,
        )

    def run_batch(
        batch: BullpenLlmBatch,
    ) -> tuple[BullpenLlmBatch, BullpenProviderBatchCall]:
        batch_events = [event_lookup[event_id] for event_id in batch.event_ids]
        prompt = _build_batch_prompt(
            prompt_template=context.prompt_template,
            events=batch_events,
        )
        return batch, execute_provider_batch_call(
            provider_name=provider_name,
            model_name=model_name,
            prompt=prompt,
        )

    pending_batches: list[BullpenLlmBatch] = list(plan.batches)
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=target_concurrency_limit
    ) as executor:
        running: dict[
            concurrent.futures.Future[tuple[BullpenLlmBatch, BullpenProviderBatchCall]],
            BullpenLlmBatch,
        ] = {}
        while pending_batches or running:
            if circuit_open and not running:
                break
            while pending_batches and len(running) < target_concurrency_limit:
                if circuit_open:
                    break
                next_batch = pending_batches.pop(0)
                future = executor.submit(run_batch, next_batch)
                running[future] = next_batch
                max_observed_concurrency = max(max_observed_concurrency, len(running))

            done, _ = concurrent.futures.wait(
                list(running.keys()),
                return_when=concurrent.futures.FIRST_COMPLETED,
            )
            for future in done:
                batch = running.pop(future)
                try:
                    completed_batch, batch_call = future.result()
                except Exception as exc:  # pragma: no cover - defensive
                    completed_batch = batch
                    batch_call = BullpenProviderBatchCall(
                        provider=provider_name,
                        model=model_name,
                        response=None,
                        attempts=1,
                        retry_count=0,
                        elapsed_seconds=0.0,
                        error=build_provider_call_error(
                            provider=provider_name,
                            requested_model=model_name,
                            execution_phase="request",
                            error=exc,
                            retryable=False,
                        ),
                    )
                retry_request_count += batch_call.retry_count
                if batch_call.response is not None:
                    total_tokens_in += int(batch_call.response.tokens_in or 0)
                    total_tokens_out += int(batch_call.response.tokens_out or 0)
                    total_cost = round(
                        total_cost + float(batch_call.response.cost or 0.0), 6
                    )
                batch_events = [
                    event_lookup[event_id] for event_id in completed_batch.event_ids
                ]
                batch_status = "completed"
                batch_error_summary = (
                    batch_call.error.safe_message if batch_call.error else None
                )
                batch_error_category = (
                    batch_call.error.execution_phase if batch_call.error else None
                )
                batch_error_details = (
                    batch_call.error.to_metadata() if batch_call.error else None
                )
                if batch_call.response is None:
                    batch_status = "failed"
                    terminal_status: Literal[
                        "provider_failed",
                        "provider_unavailable",
                        "timed_out",
                    ] = "provider_failed"
                    if batch_call.error is not None:
                        if batch_call.error.execution_phase == "capability_check":
                            terminal_status = "provider_unavailable"
                        elif "timed out" in batch_call.error.safe_message.lower():
                            terminal_status = "timed_out"
                        if not batch_call.error.retryable:
                            circuit_open = True
                    for event in batch_events:
                        event_results[event.event_id] = BullpenLlmEventProviderResult(
                            event_id=event.event_id,
                            provider=provider_name,
                            model=model_name,
                            status=terminal_status,
                            error=batch_error_summary or "Provider batch failed.",
                            attempts=batch_call.attempts,
                            batch_id=completed_batch.id,
                            web_search_used=False,
                            diagnostic=batch_error_details,
                        )
                else:
                    try:
                        parsed_response = parse_bullpen_batch_response(
                            batch_call.response.content,
                            events=batch_events,
                        )
                    except ValueError as exc:
                        batch_status = "partial"
                        batch_error_summary = str(exc)
                        batch_error_category = "invalid_json"
                        batch_error_details = {
                            "category": "invalid_json",
                            "safe_message": str(exc),
                            "provider": provider_name,
                            "requested_model": model_name,
                            "actual_model": getattr(batch_call, "actual_model", None),
                            "batch_id": completed_batch.id,
                        }
                        if (
                            completed_batch.recovery_attempt
                            < BULLPEN_LLM_MAX_RECOVERY_BATCHES
                        ):
                            recovery_batch_count += 1
                            pending_batches.append(
                                BullpenLlmBatch(
                                    id=f"{completed_batch.id}-recovery-{completed_batch.recovery_attempt + 1}",
                                    event_ids=[
                                        event.event_id for event in batch_events
                                    ],
                                    estimated_chars=estimate_batch_prompt_size_chars(
                                        prompt_template=context.prompt_template,
                                        events=batch_events,
                                    ),
                                    recovery_of_batch_id=completed_batch.id,
                                    recovery_attempt=completed_batch.recovery_attempt
                                    + 1,
                                )
                            )
                        else:
                            for event in batch_events:
                                event_results[event.event_id] = (
                                    BullpenLlmEventProviderResult(
                                        event_id=event.event_id,
                                        provider=provider_name,
                                        model=model_name,
                                        status="invalid_json",
                                        error=str(exc),
                                        attempts=batch_call.attempts,
                                        batch_id=completed_batch.id,
                                        diagnostic=batch_error_details,
                                    )
                                )
                        batch_metadata.append(
                            BullpenLlmBatchRuntimeMetadata(
                                batch_id=completed_batch.id,
                                provider=provider_name,
                                model=model_name,
                                event_ids=completed_batch.event_ids,
                                event_count=len(completed_batch.event_ids),
                                status=batch_status,
                                attempts=batch_call.attempts,
                                elapsed_seconds=batch_call.elapsed_seconds,
                                error_summary=batch_error_summary,
                                error_category=batch_error_category,
                                error_details=batch_error_details,
                                recovery_attempt=completed_batch.recovery_attempt,
                                recovered_from_batch_id=completed_batch.recovery_of_batch_id,
                            )
                        )
                        continue

                    recovery_event_ids = [
                        *parsed_response.missing_event_ids,
                        *parsed_response.invalid_event_errors.keys(),
                    ]
                    if (
                        recovery_event_ids
                        and completed_batch.recovery_attempt
                        < BULLPEN_LLM_MAX_RECOVERY_BATCHES
                    ):
                        recovery_batch_count += 1
                        pending_batches.append(
                            BullpenLlmBatch(
                                id=f"{completed_batch.id}-recovery-{completed_batch.recovery_attempt + 1}",
                                event_ids=recovery_event_ids,
                                estimated_chars=estimate_batch_prompt_size_chars(
                                    prompt_template=context.prompt_template,
                                    events=[
                                        event_lookup[event_id]
                                        for event_id in recovery_event_ids
                                    ],
                                ),
                                recovery_of_batch_id=completed_batch.id,
                                recovery_attempt=completed_batch.recovery_attempt + 1,
                            )
                        )
                    for event in batch_events:
                        row = parsed_response.rows_by_event_id.get(event.event_id)
                        invalid_reason = parsed_response.invalid_event_errors.get(
                            event.event_id
                        )
                        error_reason = None
                        status: Literal[
                            "success",
                            "recovered",
                            "invalid_schema",
                            "missing_event",
                            "evidence_blocked",
                        ]
                        if row is not None:
                            status = (
                                "recovered"
                                if completed_batch.recovery_attempt > 0
                                else "success"
                            )
                        elif invalid_reason:
                            if (
                                completed_batch.recovery_attempt
                                >= BULLPEN_LLM_MAX_RECOVERY_BATCHES
                            ):
                                status = "invalid_schema"
                            else:
                                continue
                        elif event.event_id in parsed_response.missing_event_ids:
                            if (
                                completed_batch.recovery_attempt
                                >= BULLPEN_LLM_MAX_RECOVERY_BATCHES
                            ):
                                status = "missing_event"
                                error_reason = "Model did not return this event even after targeted recovery."
                            else:
                                continue
                        else:
                            continue
                        question_runtime, stale_fact_detected, stale_fact_reason = (
                            _build_question_runtime_entry(
                                context=context,
                                event=event,
                                row=row,
                                provider_name=provider_name,
                                batch_call=batch_call,
                                invalid_reason=invalid_reason,
                                error_reason=error_reason,
                            )
                        )
                        if question_runtime.get("invalid_reason") and row is not None:
                            status = "evidence_blocked"
                            invalid_reason = str(question_runtime.get("invalid_reason"))
                        event_results[event.event_id] = BullpenLlmEventProviderResult(
                            event_id=event.event_id,
                            provider=provider_name,
                            model=model_name,
                            status=status,
                            row=row,
                            error=error_reason,
                            invalid_reason=invalid_reason,
                            stale_fact_detected=stale_fact_detected,
                            stale_fact_reason=stale_fact_reason,
                            web_search_used=bool(batch_call.response.web_search_used),
                            web_search_queries=list(
                                batch_call.response.web_search_queries
                            ),
                            web_sources=list(batch_call.response.web_sources),
                            attempts=batch_call.attempts,
                            batch_id=completed_batch.id,
                            diagnostic={
                                "category": status,
                                "provider": provider_name,
                                "requested_model": model_name,
                                "actual_model": getattr(
                                    batch_call, "actual_model", None
                                ),
                                "batch_id": completed_batch.id,
                            },
                        )
                    if (
                        parsed_response.unexpected_rows
                        or parsed_response.duplicate_event_ids
                        or parsed_response.invalid_event_errors
                        or parsed_response.missing_event_ids
                    ):
                        batch_status = "partial"
                        details: list[str] = []
                        if parsed_response.duplicate_event_ids:
                            details.append(
                                f"duplicate rows for {len(parsed_response.duplicate_event_ids)} event(s)"
                            )
                        if parsed_response.unexpected_rows:
                            details.append(
                                f"{len(parsed_response.unexpected_rows)} unexpected row(s)"
                            )
                        if parsed_response.invalid_event_errors:
                            details.append(
                                f"{len(parsed_response.invalid_event_errors)} invalid row(s)"
                            )
                        if parsed_response.missing_event_ids:
                            details.append(
                                f"{len(parsed_response.missing_event_ids)} missing event row(s)"
                            )
                        batch_error_summary = ", ".join(details) if details else None
                        if batch_error_summary and batch_error_details is None:
                            batch_error_category = "response_validation"
                            batch_error_details = _build_batch_diagnostic_metadata(
                                category="response_validation",
                                safe_message=batch_error_summary,
                                provider_name=provider_name,
                                model_name=model_name,
                                actual_model=getattr(batch_call, "actual_model", None),
                                batch_id=completed_batch.id,
                                attempts=batch_call.attempts,
                                elapsed_seconds=batch_call.elapsed_seconds,
                                recovery_attempt=completed_batch.recovery_attempt,
                                recovered_from_batch_id=completed_batch.recovery_of_batch_id,
                                extra={
                                    "duplicate_event_count": len(
                                        parsed_response.duplicate_event_ids
                                    ),
                                    "unexpected_row_count": len(
                                        parsed_response.unexpected_rows
                                    ),
                                    "invalid_event_count": len(
                                        parsed_response.invalid_event_errors
                                    ),
                                    "missing_event_count": len(
                                        parsed_response.missing_event_ids
                                    ),
                                    "missing_event_ids": parsed_response.missing_event_ids[
                                        :25
                                    ],
                                    "invalid_event_errors": dict(
                                        list(
                                            parsed_response.invalid_event_errors.items()
                                        )[:25]
                                    ),
                                },
                            )

                batch_metadata.append(
                    BullpenLlmBatchRuntimeMetadata(
                        batch_id=completed_batch.id,
                        provider=provider_name,
                        model=model_name,
                        event_ids=completed_batch.event_ids,
                        event_count=len(completed_batch.event_ids),
                        status=batch_status,
                        attempts=batch_call.attempts,
                        elapsed_seconds=batch_call.elapsed_seconds,
                        error_summary=batch_error_summary,
                        error_category=batch_error_category,
                        error_details=batch_error_details,
                        recovery_attempt=completed_batch.recovery_attempt,
                        recovered_from_batch_id=completed_batch.recovery_of_batch_id,
                    )
                )

    if circuit_open:
        for batch in pending_batches:
            for event_id in batch.event_ids:
                if event_id in event_results:
                    continue
                event_results[event_id] = BullpenLlmEventProviderResult(
                    event_id=event_id,
                    provider=provider_name,
                    model=model_name,
                    status="circuit_open",
                    error="Provider circuit breaker opened after a non-retryable batch failure.",
                    batch_id=batch.id,
                    diagnostic={
                        "category": "circuit_open",
                        "provider": provider_name,
                        "requested_model": model_name,
                        "batch_id": batch.id,
                    },
                )
            batch_metadata.append(
                BullpenLlmBatchRuntimeMetadata(
                    batch_id=batch.id,
                    provider=provider_name,
                    model=model_name,
                    event_ids=batch.event_ids,
                    event_count=len(batch.event_ids),
                    status="skipped",
                    attempts=0,
                    elapsed_seconds=0.0,
                    error_summary="Provider circuit breaker opened.",
                    error_category="circuit_open",
                    error_details={
                        "category": "circuit_open",
                        "provider": provider_name,
                        "requested_model": model_name,
                        "batch_id": batch.id,
                    },
                    recovery_attempt=batch.recovery_attempt,
                    recovered_from_batch_id=batch.recovery_of_batch_id,
                )
            )

    unrecorded_event_ids: list[str] = []
    for event in prepared_events:
        if event.event_id not in event_results:
            unrecorded_event_ids.append(event.event_id)
            diagnostic = _build_batch_diagnostic_metadata(
                category="missing_terminal_result",
                safe_message="No terminal result was recorded for this event.",
                provider_name=provider_name,
                model_name=model_name,
                batch_id="missing-terminal-results",
                extra={"event_id": event.event_id},
            )
            event_results[event.event_id] = BullpenLlmEventProviderResult(
                event_id=event.event_id,
                provider=provider_name,
                model=model_name,
                status="provider_failed",
                error="No terminal result was recorded for this event.",
                diagnostic=diagnostic,
            )
    if unrecorded_event_ids:
        batch_metadata.append(
            BullpenLlmBatchRuntimeMetadata(
                batch_id="missing-terminal-results",
                provider=provider_name,
                model=model_name,
                event_ids=unrecorded_event_ids,
                event_count=len(unrecorded_event_ids),
                status="failed",
                attempts=0,
                elapsed_seconds=0.0,
                error_summary="No terminal result was recorded for one or more events.",
                error_category="missing_terminal_result",
                error_details=_build_batch_diagnostic_metadata(
                    category="missing_terminal_result",
                    safe_message="No terminal result was recorded for one or more events.",
                    provider_name=provider_name,
                    model_name=model_name,
                    batch_id="missing-terminal-results",
                    extra={"event_ids": unrecorded_event_ids[:25]},
                ),
            )
        )

    runtime_metadata = _build_runtime_metadata(
        context=context,
        execution_options=execution_options,
        event_lookup=event_lookup,
        event_results=event_results,
        batch_metadata=batch_metadata,
        provider_name=provider_name,
        model_name=model_name,
        prompt_size_estimates=prompt_size_estimates,
        primary_request_count=plan.expected_primary_request_count,
        retry_request_count=retry_request_count,
        recovery_batch_count=recovery_batch_count,
        max_observed_concurrency=max_observed_concurrency,
    )
    if execution_mode_reason:
        runtime_metadata["llm_execution_mode_reason"] = execution_mode_reason
        runtime_metadata["warnings"] = _merge_unique_strings(
            [*(runtime_metadata.get("warnings") or []), execution_mode_reason]
        )
    response_text = json.dumps(
        {
            "markets": [
                _serialize_final_market_row(event, event_results.get(event.event_id))
                for event in sorted(
                    prepared_events, key=lambda item: item.original_index
                )
            ]
        },
        ensure_ascii=False,
        indent=2,
    )

    recovered_event_count = sum(
        1
        for event_result in event_results.values()
        if event_result.status == "recovered"
    )
    failed_event_count = sum(
        1
        for event_result in event_results.values()
        if event_result.status
        in {"provider_failed", "provider_unavailable", "timed_out", "circuit_open"}
    )
    blocked_event_count = sum(
        1
        for event_result in event_results.values()
        if event_result.status in {"evidence_blocked", "circuit_open"}
    )
    invalid_event_count = sum(
        1
        for event_result in event_results.values()
        if event_result.status in {"invalid_json", "invalid_schema", "missing_event"}
    )
    complete_event_count = sum(
        1
        for event_result in event_results.values()
        if event_result.status in {"success", "recovered"}
    )
    execution_status: Literal["completed", "partial", "failed"]
    if (
        complete_event_count == len(event_results)
        and invalid_event_count == 0
        and failed_event_count == 0
        and blocked_event_count == 0
    ):
        execution_status = "completed"
    elif complete_event_count == 0:
        execution_status = "failed"
    else:
        execution_status = "partial"

    web_search_queries = _merge_unique_strings(
        [
            *(runtime_metadata.get("web_search_queries") or []),
        ]
    )
    web_sources = _merge_unique_strings([*(runtime_metadata.get("web_sources") or [])])

    return BullpenLlmTargetExecutionResult(
        provider=provider_name,
        model=model_name,
        response_text=response_text,
        runtime_metadata=runtime_metadata,
        event_results=event_results,
        batch_metadata=batch_metadata,
        status=execution_status,
        tokens_in=total_tokens_in,
        tokens_out=total_tokens_out,
        estimated_cost=round(total_cost, 6),
        web_search_used=bool(runtime_metadata.get("web_search_used")),
        web_search_queries=web_search_queries,
        web_sources=web_sources,
        primary_request_count=plan.expected_primary_request_count,
        retry_request_count=retry_request_count,
        recovery_batch_count=recovery_batch_count,
        recovered_event_count=recovered_event_count,
        failed_event_count=failed_event_count,
        blocked_event_count=blocked_event_count,
        invalid_event_count=invalid_event_count,
        max_observed_concurrency=max_observed_concurrency,
        prompt_size_estimates=prompt_size_estimates,
    )


def _build_runtime_metadata(
    *,
    context: PolymarketEventRunContext,
    execution_options: BullpenLlmExecutionOptions,
    event_lookup: dict[str, PreparedBullpenLlmEvent],
    event_results: dict[str, BullpenLlmEventProviderResult],
    batch_metadata: list[BullpenLlmBatchRuntimeMetadata],
    provider_name: str,
    model_name: str,
    prompt_size_estimates: list[dict[str, Any]],
    primary_request_count: int,
    retry_request_count: int,
    recovery_batch_count: int,
    max_observed_concurrency: int,
) -> dict[str, Any]:
    question_runtime: dict[str, Any] = {}
    all_queries: list[str] = []
    all_sources: list[str] = []
    warnings: list[str] = []
    stale_fact_detected = False
    invalid_reasons: list[str] = []
    for event_id, event in event_lookup.items():
        event_result = event_results.get(event_id)
        entry = dict(event.question_runtime)
        if event_result is not None:
            entry["web_search_used"] = bool(
                entry.get("web_search_used") or event_result.web_search_used
            )
            entry["web_search_queries"] = _merge_unique_strings(
                [
                    *(entry.get("web_search_queries") or []),
                    *event_result.web_search_queries,
                ]
            )
            entry["web_sources"] = _merge_unique_strings(
                [*(entry.get("web_sources") or []), *event_result.web_sources]
            )
            entry["stale_fact_detected"] = bool(event_result.stale_fact_detected)
            if event_result.invalid_reason:
                entry["invalid_reason"] = event_result.invalid_reason
            elif event_result.error and not entry.get("invalid_reason"):
                entry["invalid_reason"] = event_result.error
            entry["status"] = event_result.status
            if event_result.diagnostic is not None:
                entry["diagnostic"] = event_result.diagnostic
            entry["internet_verified"] = bool(
                entry.get("internet_verified")
                or entry.get("web_search_used")
                or entry.get("evidence_block_used")
                or entry.get("web_sources")
            )
            all_queries.extend(entry.get("web_search_queries") or [])
            all_sources.extend(entry.get("web_sources") or [])
            stale_fact_detected = stale_fact_detected or bool(
                entry.get("stale_fact_detected")
            )
            if entry.get("invalid_reason"):
                invalid_reasons.append(str(entry["invalid_reason"]))
                warnings.append(str(entry["invalid_reason"]))
            if event_result.error:
                warnings.append(event_result.error)
        question_runtime[event.question_payload.question_id] = entry

    return {
        "kind": context.kind,
        "require_fresh_internet_evidence": context.evidence_options.require_fresh_internet_evidence,
        "allow_evidence_grounded_non_web_models": context.evidence_options.allow_evidence_grounded_non_web_models,
        "web_search_used": bool(all_queries or all_sources),
        "web_search_queries": _merge_unique_strings(all_queries),
        "web_sources": _merge_unique_strings(all_sources),
        "evidence_block_used": any(
            bool((event.question_payload.preflight_evidence_block or "").strip())
            for event in event_lookup.values()
        ),
        "internet_verified": (
            all(
                bool(entry.get("internet_verified"))
                for entry in question_runtime.values()
            )
            if question_runtime
            else False
        ),
        "stale_fact_detected": stale_fact_detected,
        "invalid_reason": invalid_reasons[0] if invalid_reasons else None,
        "model_side_search_used": any(
            bool(entry.get("web_search_used")) for entry in question_runtime.values()
        ),
        "question_runtime": question_runtime,
        "schema_version": 2,
        "warnings": _merge_unique_strings(warnings),
        "llm_execution_mode": execution_options.execution_mode,
        "llm_events_per_prompt": execution_options.events_per_prompt,
        "llm_event_count": len(event_lookup),
        "llm_batch_count": len(
            [batch for batch in batch_metadata if batch.recovery_attempt == 0]
        ),
        "llm_completed_batch_count": len(batch_metadata),
        "llm_primary_request_count": primary_request_count,
        "llm_retry_request_count": retry_request_count,
        "llm_recovery_batch_count": recovery_batch_count,
        "llm_recovered_event_count": sum(
            1 for result in event_results.values() if result.status == "recovered"
        ),
        "llm_failed_event_count": sum(
            1
            for result in event_results.values()
            if result.status
            in {"provider_failed", "provider_unavailable", "timed_out", "circuit_open"}
        ),
        "llm_invalid_event_count": sum(
            1
            for result in event_results.values()
            if result.status in {"invalid_json", "invalid_schema", "missing_event"}
        ),
        "llm_blocked_event_count": sum(
            1
            for result in event_results.values()
            if result.status in {"evidence_blocked", "circuit_open"}
        ),
        "llm_provider_target_count": execution_options.target_count,
        "llm_request_concurrency_limit": derive_target_request_concurrency(
            max_concurrent_requests=execution_options.max_concurrent_requests,
            target_count=execution_options.target_count,
        ),
        "llm_max_observed_concurrency": max_observed_concurrency,
        "llm_prompt_template_hash": execution_options.prompt_template_hash,
        "llm_prompt_size_estimates": prompt_size_estimates,
        "llm_batches": [
            {
                "batch_id": batch.batch_id,
                "event_count": batch.event_count,
                "event_ids": batch.event_ids,
                "status": batch.status,
                "provider": batch.provider,
                "model": batch.model,
                "attempts": batch.attempts,
                "elapsed_seconds": batch.elapsed_seconds,
                "error_summary": batch.error_summary,
                "error_category": batch.error_category,
                "error_details": batch.error_details,
                "recovery_attempt": batch.recovery_attempt,
                "recovered_from_batch_id": batch.recovered_from_batch_id,
            }
            for batch in batch_metadata
        ],
        "llm_event_results": {
            event_id: {
                "status": result.status,
                "error": result.error,
                "invalid_reason": result.invalid_reason,
                "diagnostic": result.diagnostic,
                "batch_id": result.batch_id,
                "attempts": result.attempts,
            }
            for event_id, result in event_results.items()
        },
        "llm_provider": provider_name,
        "llm_model": model_name,
    }


def event_result_to_auto_live_output(
    event_result: BullpenLlmEventProviderResult,
    *,
    completed_at: str | None = None,
) -> BullpenAutoLiveLlmOutput:
    row = event_result.row
    return BullpenAutoLiveLlmOutput(
        provider=event_result.provider,
        model=event_result.model,
        status=event_result.status,
        llm_yes_odds=row.llm_yes_odds if row is not None else None,
        llm_no_odds=row.llm_no_odds if row is not None else None,
        confidence=row.confidence if row is not None else None,
        evidence_status=row.evidence_status if row is not None else None,
        event_state=row.event_state if row is not None else None,
        key_evidence=row.key_evidence if row is not None else [],
        red_flags=row.red_flags if row is not None else [],
        rationale=row.rationale if row is not None else event_result.invalid_reason,
        error=event_result.error,
        completed_at=completed_at or datetime.now(UTC).isoformat(),
        invalid_reason=event_result.invalid_reason,
        diagnostic=event_result.diagnostic,
    )
