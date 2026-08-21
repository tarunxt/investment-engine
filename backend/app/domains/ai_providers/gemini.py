from __future__ import annotations

import math
from typing import Any

from google import genai
from google.genai import types

from app.core.config import get_gemini_api_keys
from app.domains.ai_providers.base import (
    AIProviderResponse,
    BaseAIProvider,
    ProviderCallError,
)
from app.domains.ai_providers.web_metadata import (
    dedupe_strings,
    merge_web_metadata,
)

MODEL_PRICING_PER_1M_TOKENS = {
    "gemini-2.5-flash": {
        "input": 0.5,
        "output": 3.00,
    },
    "gemini-3-flash-preview": {
        "input": 0.50,
        "output": 3.00,
    },
}

SUPPORTED_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-3-flash-preview",
]

MAX_OUTPUT_TOKENS = 12000
MAX_RESPONSE_CHARS = 60000
REPAIR_PROMPT_MARKERS = (
    "[REBALANCE_TABLE_REPAIR]",
    "[STOCK_TABLE_REPAIR]",
)
DISABLE_SEARCH_PROMPT_MARKERS = (
    "[STAGE2_SHARED_EVIDENCE_ONLY]",
    *REPAIR_PROMPT_MARKERS,
)


def _should_disable_search(prompt: str) -> bool:
    return any(marker in (prompt or "") for marker in DISABLE_SEARCH_PROMPT_MARKERS)


def _thinking_config_for_model(model: str) -> types.ThinkingConfig | None:
    # Gemini 2.5 Flash spends part of max_output_tokens on hidden thinking by
    # default. Table jobs need deterministic visible rows more than hidden
    # reasoning, so keep thinking disabled for Flash while leaving other models
    # on provider defaults.
    if model == "gemini-2.5-flash":
        return types.ThinkingConfig(thinking_budget=0)
    return None


def _error_attr(exc: Exception, name: str) -> Any:
    for candidate in (
        name,
        name.lower(),
        name.upper(),
        "".join(part.capitalize() for part in name.split("_")),
    ):
        if hasattr(exc, candidate):
            return getattr(exc, candidate)
    return None


def _should_rotate_key(exc: Exception) -> bool:
    msg = str(exc).lower()
    status_code = (
        _error_attr(exc, "status_code")
        or _error_attr(exc, "code")
        or _error_attr(exc, "http_status")
    )
    try:
        status_int = int(status_code) if status_code is not None else None
    except (TypeError, ValueError):
        status_int = None

    if status_int in {429, 500, 502, 503, 504}:
        return True

    transient_markers = [
        "429",
        "503",
        "quota",
        "rate limit",
        "rate-limit",
        "resource_exhausted",
        "resource exhausted",
        "unavailable",
        "temporarily unavailable",
        "try again later",
        "deadline exceeded",
        "timed out",
        "timeout",
        "internal",
    ]
    return any(marker in msg for marker in transient_markers)


def _extract_grounding_web_metadata(chunk: object) -> tuple[list[str], list[str]]:
    queries: list[str] = []
    sources: list[str] = []

    for candidate in getattr(chunk, "candidates", None) or []:
        grounding_metadata = getattr(candidate, "grounding_metadata", None)
        if grounding_metadata is None:
            continue

        queries.extend(getattr(grounding_metadata, "web_search_queries", None) or [])

        for grounding_chunk in getattr(grounding_metadata, "grounding_chunks", None) or []:
            web_chunk = getattr(grounding_chunk, "web", None)
            if web_chunk is None:
                continue
            uri = getattr(web_chunk, "uri", None)
            title = getattr(web_chunk, "title", None)
            if isinstance(uri, str) and uri.strip():
                sources.append(uri)
            elif isinstance(title, str) and title.strip():
                sources.append(title)

    return dedupe_strings(queries), dedupe_strings(sources)


class GeminiProvider(BaseAIProvider):
    provider_name = "gemini"

    supported_models = SUPPORTED_MODELS

    @classmethod
    def is_configured(cls) -> bool:
        return bool(get_gemini_api_keys())

    def __init__(self) -> None:
        self._api_keys = get_gemini_api_keys()
        if not self._api_keys:
            raise ValueError("GEMINI_API_KEY is not configured")
        self.client = genai.Client(
            api_key=self._api_keys[0],
            http_options={"api_version": "v1alpha"},
        )

    def generate(
        self,
        *,
        prompt: str,
        model: str,
    ) -> AIProviderResponse:
        if model not in self.supported_models:
            raise ProviderCallError(
                provider=self.provider_name,
                requested_model=model,
                actual_model=None,
                execution_phase="capability_check",
                safe_message=f"Gemini model '{model}' is not supported by this adapter.",
                retryable=False,
            )
        last_error: Exception | None = None
        requested_model = (model or "").strip()
        for api_key in self._api_keys:
            try:
                self.client = genai.Client(
                    api_key=api_key,
                    http_options={"api_version": "v1alpha"},
                )
                return self._generate_once(prompt=prompt, model=requested_model)
            except Exception as exc:
                last_error = exc
                should_retry_with_next_key = _should_rotate_key(exc)
                if not should_retry_with_next_key:
                    raise
                continue
        if last_error:
            raise last_error
        raise RuntimeError("Gemini generation failed.")

    def _generate_once(
        self,
        *,
        prompt: str,
        model: str,
    ) -> AIProviderResponse:
        tools: list[types.Tool] = []

        if not _should_disable_search(prompt):
            tools.append(types.Tool(google_search=types.GoogleSearch()))

        config = types.GenerateContentConfig(
            thinking_config=_thinking_config_for_model(model),
            temperature=0.7,
            max_output_tokens=MAX_OUTPUT_TOKENS,
            tools=tools if tools else None,
        )

        contents = [
            types.Content(
                role="user",
                parts=[types.Part.from_text(text=prompt)],
            )
        ]

        full_text_parts: list[str] = []
        max_chars = MAX_RESPONSE_CHARS

        usage_metadata = None
        web_search_used = False
        web_search_queries: list[str] = []
        web_sources: list[str] = []

        stream = self.client.models.generate_content_stream(
            model=model,
            contents=contents,
            config=config,
        )

        for chunk in stream:

            text = getattr(chunk, "text", None)

            if text:
                full_text_parts.append(text)
                if sum(len(part) for part in full_text_parts) > max_chars:
                    raise ValueError(
                        "Generated response exceeded safety output limit for this prompt. Please retry."
                    )

            metadata = getattr(
                chunk,
                "usage_metadata",
                None,
            )

            if metadata:
                usage_metadata = metadata

            chunk_queries, chunk_sources = _extract_grounding_web_metadata(chunk)
            web_search_used, web_search_queries, web_sources = merge_web_metadata(
                web_search_used,
                web_search_queries,
                web_sources,
                response_used=bool(chunk_queries or chunk_sources),
                response_queries=chunk_queries,
                response_sources=chunk_sources,
            )

        full_text = "".join(full_text_parts)

        tokens_in = int(
            getattr(
                usage_metadata,
                "prompt_token_count",
                0,
            )
            or 0
        )

        tokens_out = int(
            getattr(
                usage_metadata,
                "candidates_token_count",
                0,
            )
            or 0
        )
        tool_use_prompt_tokens = int(
            getattr(
                usage_metadata,
                "tool_use_prompt_token_count",
                0,
            )
            or 0
        )
        if tool_use_prompt_tokens > 0:
            web_search_used = True

        return AIProviderResponse(
            content=full_text.strip(),
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost=self._estimate_cost(
                model=model,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
            ),
            provider=self.provider_name,
            model=model,
            web_search_used=web_search_used,
            web_search_queries=web_search_queries,
            web_sources=web_sources,
        )

    @staticmethod
    def _estimate_cost(
        *,
        model: str,
        tokens_in: int,
        tokens_out: int,
    ) -> float:

        pricing = MODEL_PRICING_PER_1M_TOKENS.get(model)

        if not pricing:
            return 0.0

        return round(
            (tokens_in / 1_000_000) * pricing["input"]
            + (tokens_out / 1_000_000) * pricing["output"],
            6,
        )

    @staticmethod
    def estimate_prompt_cost_usd(model: str, prompt: str) -> float:
        pricing = MODEL_PRICING_PER_1M_TOKENS.get(model)
        if not pricing:
            return 0.0
        prompt_tokens = max(1, math.ceil(len(prompt) / 4))
        expected_output_tokens = 5000
        return round(
            (prompt_tokens / 1_000_000) * pricing["input"]
            + (expected_output_tokens / 1_000_000) * pricing["output"],
            6,
        )
