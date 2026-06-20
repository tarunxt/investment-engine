from __future__ import annotations

import datetime
import json
import logging
import math
import re

from openai import OpenAI

from app.core.config import settings
from app.domains.ai_providers.base import AIProviderResponse, BaseAIProvider
from app.domains.ai_providers.tools import web_search as web_search_tool

logger = logging.getLogger("app")

DEEPSEEK_PRICING_PER_1M_TOKENS = {
    "deepseek-v4-flash": {
        "cache_hit_input": 0.0028,
        "cache_miss_input": 0.14,
        "output": 0.28,
    },
    "deepseek-v4-pro": {
        "cache_hit_input": 0.003625,
        "cache_miss_input": 0.435,
        "output": 0.87,
    },
}
DEFAULT_DEEPSEEK_PRICING_PER_1M_TOKENS = DEEPSEEK_PRICING_PER_1M_TOKENS[
    "deepseek-v4-flash"
]

SUPPORTED_MODELS = [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-reasoner",
    "deepseek-chat",
    "deepseek-coder",
    "deepseek-r1",
    "deepseek-v3",
]

current_date = datetime.datetime.now().strftime("%Y-%m-%d")

_SYSTEM_MESSAGE: dict = {
    "role": "system",
    "content": (
        "You have access to a web_search tool that fetches live data from the internet. "
        "ALWAYS use it to get current stock prices, market indices, news, and any "
        "real-time information before making analysis or recommendations. "
        "Never rely on your training data for current prices or market levels. "
        f"Current date: {current_date}. "
        "After using tools, always produce a final answer in the exact format requested by the user."
    ),
}

_MAX_TOOL_ROUNDS = 8
_MAX_DSML_RECOVERY_SEARCHES = 4


def _looks_like_tool_trace(text: str) -> bool:
    lowered = text.lower()
    return (
        "<| dsml" in lowered
        or "tool_calls" in lowered
        or "invoke name=" in lowered
        or "<| parameter name=" in lowered
    )


def _looks_like_valid_markdown_table(text: str) -> bool:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    pipe_lines = [line for line in lines if line.count("|") >= 2]
    if len(pipe_lines) < 3:
        return False
    has_separator = any(re.fullmatch(r"\|?[\s:\-|\t]+\|?", line) for line in pipe_lines)
    return has_separator


def _requires_markdown_table_output(prompt: str) -> bool:
    text = (prompt or "").lower()
    return (
        "return only one markdown table" in text
        or "return a valid markdown table" in text
        or "return only a markdown table" in text
        or "table columns:" in text
    )


def _requires_json_output(prompt: str) -> bool:
    text = (prompt or "").lower()
    json_markers = (
        "return strict json",
        "return only valid json",
        "return valid json",
        "return json only",
        "return strict json only",
        "json schema",
        "top-level \"markets\"",
        "do not include markdown",
    )
    return any(marker in text for marker in json_markers)


def _determine_output_kind(prompt: str) -> str:
    if _requires_json_output(prompt):
        return "json"
    if _requires_markdown_table_output(prompt):
        return "markdown_table"
    return "plain"


def _extract_json_value_from_text(text: str) -> object | None:
    trimmed = (text or "").strip()
    if not trimmed:
        return None

    candidates: list[str] = []

    def register(candidate: str | None) -> None:
        if not candidate:
            return
        normalized = candidate.strip()
        if normalized and normalized not in candidates:
            candidates.append(normalized)

    for match in re.finditer(r"```(?:json)?\s*([\s\S]*?)```", trimmed, flags=re.IGNORECASE):
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

    return None


def _normalize_json_output_text(text: str) -> str | None:
    parsed = _extract_json_value_from_text(text)
    if parsed is None:
        return None
    return json.dumps(parsed, ensure_ascii=False)


def _extract_dsml_web_search_calls(text: str) -> list[dict[str, int | str]]:
    calls: list[dict[str, int | str]] = []
    segments = re.findall(
        r'invoke name="web_search">(.*?)</[^>]*invoke>',
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for segment in segments:
        query_match = re.search(
            r'parameter name="query"[^>]*>(.*?)</[^>]*parameter>',
            segment,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if not query_match:
            continue
        query = " ".join(query_match.group(1).split()).strip()
        if not query:
            continue

        max_results = 5
        max_results_match = re.search(
            r'parameter name="max_results"[^>]*>(.*?)</[^>]*parameter>',
            segment,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if max_results_match:
            digits = re.search(r"\d+", max_results_match.group(1))
            if digits:
                max_results = int(digits.group(0))
        calls.append({"query": query, "max_results": max(1, min(max_results, 8))})
    return calls


class DeepSeekProvider(BaseAIProvider):
    provider_name = "deepseek"
    supported_models = SUPPORTED_MODELS

    @classmethod
    def is_configured(cls) -> bool:
        return bool(settings.deepseek_api_key)

    def __init__(self) -> None:
        if not settings.deepseek_api_key:
            raise ValueError("DEEPSEEK_API_KEY is not configured")
        self.client = OpenAI(
            api_key=settings.deepseek_api_key,
            base_url=settings.deepseek_api_base or "https://api.deepseek.com/v1",
        )

    def _recover_from_dsml_tool_trace(
        self,
        *,
        prompt: str,
        tool_trace: str,
        model: str,
        output_kind: str,
    ) -> tuple[str, dict[str, int]]:
        empty_token_usage = self._token_usage_from_response_usage(None)
        search_calls = _extract_dsml_web_search_calls(tool_trace)
        if not search_calls:
            return tool_trace, empty_token_usage

        search_payloads: list[dict[str, str | int]] = []
        seen_queries: set[str] = set()
        for call in search_calls:
            query = str(call["query"]).strip()
            if not query or query in seen_queries:
                continue
            seen_queries.add(query)
            result = web_search_tool.execute(
                "web_search",
                {
                    "query": query,
                    "max_results": int(call["max_results"]),
                },
            )
            search_payloads.append(
                {
                    "query": query,
                    "max_results": int(call["max_results"]),
                    "result": result,
                }
            )
            if len(search_payloads) >= _MAX_DSML_RECOVERY_SEARCHES:
                break

        if not search_payloads:
            return tool_trace, empty_token_usage

        if output_kind == "json":
            recovery_instruction = (
                "Return ONLY valid JSON in the exact schema and shape requested by the user."
            )
        elif output_kind == "markdown_table":
            recovery_instruction = (
                "Return ONLY one valid markdown table with a header row, separator row, "
                "and at least 5 data rows in the exact format requested by the user."
            )
        else:
            recovery_instruction = (
                "Return the clean final answer immediately in the exact format requested by the user."
            )

        recovery_response = self.client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are given live web-search results already collected for the user. "
                        "Do not call tools. Do not output XML, DSML, or tool traces. "
                        f"{recovery_instruction}"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Original user request:\n{prompt}\n\n"
                        "Your previous attempt returned an invalid tool-call trace instead of the "
                        "final answer. Use the collected search results below and produce the final "
                        "markdown table now.\n\n"
                        f"Collected search results JSON:\n{json.dumps(search_payloads, ensure_ascii=False)}"
                    ),
                },
            ],
            tool_choice="none",
        )
        usage = getattr(recovery_response, "usage", None)
        token_usage = self._token_usage_from_response_usage(usage)
        choices = getattr(recovery_response, "choices", []) or []
        recovered = tool_trace
        if choices:
            recovered = (
                getattr(choices[0].message, "content", "") or ""
            ).strip() or tool_trace
        return recovered, token_usage

    def generate(self, *, prompt: str, model: str) -> AIProviderResponse:
        if model not in self.supported_models:
            model = "deepseek-v4-flash"

        SYSTEM_MESSAGE = _SYSTEM_MESSAGE.copy()
        # SYSTEM_MESSAGE["content"] = _SYSTEM_MESSAGE["content"].replace("{{current_date}}", current_date).replace("{{model}}", model)
        output_kind = _determine_output_kind(prompt)

        messages: list[dict] = [
            SYSTEM_MESSAGE,
            {"role": "user", "content": prompt},
        ]
        kwargs: dict = {
            "model": model,
            "messages": messages,
            "tools": web_search_tool.TOOL_DEFINITIONS,
            "tool_choice": "auto",
        }

        total_tokens_in = 0
        total_tokens_out = 0
        total_cache_hit_tokens = 0
        total_cache_miss_tokens = 0
        content = ""

        logger.info(f"DeepSeek request with kwargs: {kwargs}")
        for round_num in range(_MAX_TOOL_ROUNDS):
            response = self.client.chat.completions.create(**kwargs)
            logger.info(f"DeepSeek response round {round_num + 1}: {response}")
            usage = getattr(response, "usage", None)
            token_usage = self._token_usage_from_response_usage(usage)
            total_tokens_in += token_usage["tokens_in"]
            total_tokens_out += token_usage["tokens_out"]
            total_cache_hit_tokens += token_usage["cache_hit_tokens"]
            total_cache_miss_tokens += token_usage["cache_miss_tokens"]

            choices = getattr(response, "choices", []) or []
            if not choices:
                break

            message = choices[0].message
            tool_calls = getattr(message, "tool_calls", None)

            if not tool_calls:
                content = getattr(message, "content", "") or ""
                break

            logger.info(
                "DeepSeek tool calls round %d: %s",
                round_num + 1,
                [tc.function.name for tc in tool_calls],
            )

            # Append assistant message with tool_calls as a plain dict.
            # reasoning_content must be echoed back when present (DeepSeek thinking mode).
            assistant_msg: dict = {
                "role": "assistant",
                "content": getattr(message, "content", None),
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in tool_calls
                ],
            }
            reasoning_content = getattr(message, "reasoning_content", None)
            if reasoning_content:
                assistant_msg["reasoning_content"] = reasoning_content
            messages.append(assistant_msg)

            # Execute each tool and append results
            for tc in tool_calls:
                try:
                    args = json.loads(tc.function.arguments)
                except json.JSONDecodeError:
                    args = {}
                result = web_search_tool.execute(tc.function.name, args)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": result,
                    }
                )

            kwargs["messages"] = messages

        # If tool loop did not produce final content, force a final assistant turn
        # without tools so we don't silently return empty output.
        if not content:
            final_response = self.client.chat.completions.create(
                model=model,
                messages=messages
                + [
                    {
                        "role": "system",
                        "content": (
                            "Stop calling tools now. Produce the final answer immediately "
                            "in the exact format requested by the user."
                        ),
                    }
                ],
                tool_choice="none",
            )
            final_usage = getattr(final_response, "usage", None)
            final_token_usage = self._token_usage_from_response_usage(final_usage)
            total_tokens_in += final_token_usage["tokens_in"]
            total_tokens_out += final_token_usage["tokens_out"]
            total_cache_hit_tokens += final_token_usage["cache_hit_tokens"]
            total_cache_miss_tokens += final_token_usage["cache_miss_tokens"]
            final_choices = getattr(final_response, "choices", []) or []
            if final_choices:
                content = getattr(final_choices[0].message, "content", "") or ""

        cleaned = content.strip()
        if _looks_like_tool_trace(cleaned):
            recovered, recovered_token_usage = self._recover_from_dsml_tool_trace(
                prompt=prompt,
                tool_trace=cleaned,
                model=model,
                output_kind=output_kind,
            )
            cleaned = recovered.strip()
            total_tokens_in += recovered_token_usage["tokens_in"]
            total_tokens_out += recovered_token_usage["tokens_out"]
            total_cache_hit_tokens += recovered_token_usage["cache_hit_tokens"]
            total_cache_miss_tokens += recovered_token_usage["cache_miss_tokens"]

        if output_kind == "json":
            normalized_json = _normalize_json_output_text(cleaned)
            if normalized_json is not None:
                cleaned = normalized_json

            needs_rewrite = _looks_like_tool_trace(cleaned) or normalized_json is None
            if needs_rewrite:
                rewrite_response = self.client.chat.completions.create(
                    model=model,
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                "Convert the following assistant output into a clean final answer. "
                                "Return ONLY valid JSON that matches the user's requested schema. "
                                "No tool traces, no XML/DSML tags, no markdown, and no extra commentary."
                            ),
                        },
                        {"role": "user", "content": prompt},
                        {"role": "assistant", "content": cleaned},
                    ],
                    tool_choice="none",
                )
                rewrite_usage = getattr(rewrite_response, "usage", None)
                rewrite_token_usage = self._token_usage_from_response_usage(rewrite_usage)
                total_tokens_in += rewrite_token_usage["tokens_in"]
                total_tokens_out += rewrite_token_usage["tokens_out"]
                total_cache_hit_tokens += rewrite_token_usage["cache_hit_tokens"]
                total_cache_miss_tokens += rewrite_token_usage["cache_miss_tokens"]
                rewrite_choices = getattr(rewrite_response, "choices", []) or []
                if rewrite_choices:
                    rewritten = (
                        getattr(rewrite_choices[0].message, "content", "") or ""
                    ).strip()
                    cleaned = _normalize_json_output_text(rewritten) or rewritten
        elif output_kind == "markdown_table":
            needs_rewrite = _looks_like_tool_trace(
                cleaned
            ) or not _looks_like_valid_markdown_table(cleaned)
            if needs_rewrite:
                rewrite_response = self.client.chat.completions.create(
                    model=model,
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                "Convert the following assistant output into a clean final answer. "
                                "Return ONLY a valid markdown table with proper header row, separator row, and 5 data rows. "
                                "No tool traces, no XML/DSML tags, no extra commentary."
                            ),
                        },
                        {"role": "user", "content": prompt},
                        {"role": "assistant", "content": cleaned},
                    ],
                    tool_choice="none",
                )
                rewrite_usage = getattr(rewrite_response, "usage", None)
                rewrite_token_usage = self._token_usage_from_response_usage(rewrite_usage)
                total_tokens_in += rewrite_token_usage["tokens_in"]
                total_tokens_out += rewrite_token_usage["tokens_out"]
                total_cache_hit_tokens += rewrite_token_usage["cache_hit_tokens"]
                total_cache_miss_tokens += rewrite_token_usage["cache_miss_tokens"]
                rewrite_choices = getattr(rewrite_response, "choices", []) or []
                if rewrite_choices:
                    cleaned = (
                        getattr(rewrite_choices[0].message, "content", "") or ""
                    ).strip()
        elif _looks_like_tool_trace(cleaned):
            rewrite_response = self.client.chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "Convert the following assistant output into a clean final answer. "
                            "Follow the original user request exactly. "
                            "No tool traces, no XML/DSML tags, and no extra commentary."
                        ),
                    },
                    {"role": "user", "content": prompt},
                    {"role": "assistant", "content": cleaned},
                ],
                tool_choice="none",
            )
            rewrite_usage = getattr(rewrite_response, "usage", None)
            rewrite_token_usage = self._token_usage_from_response_usage(rewrite_usage)
            total_tokens_in += rewrite_token_usage["tokens_in"]
            total_tokens_out += rewrite_token_usage["tokens_out"]
            total_cache_hit_tokens += rewrite_token_usage["cache_hit_tokens"]
            total_cache_miss_tokens += rewrite_token_usage["cache_miss_tokens"]
            rewrite_choices = getattr(rewrite_response, "choices", []) or []
            if rewrite_choices:
                cleaned = (
                    getattr(rewrite_choices[0].message, "content", "") or ""
                ).strip()

        return AIProviderResponse(
            content=cleaned,
            tokens_in=total_tokens_in,
            tokens_out=total_tokens_out,
            cost=self._estimate_cost(
                model=model,
                tokens_in=total_tokens_in,
                tokens_out=total_tokens_out,
                cache_hit_tokens=total_cache_hit_tokens,
                cache_miss_tokens=total_cache_miss_tokens,
            ),
            provider=self.provider_name,
            model=model,
        )

    @staticmethod
    def _usage_int(usage: object | None, field: str) -> int:
        value = getattr(usage, field, 0) if usage is not None else 0
        try:
            return max(0, int(value or 0))
        except (TypeError, ValueError):
            return 0

    @classmethod
    def _token_usage_from_response_usage(cls, usage: object | None) -> dict[str, int]:
        tokens_in = cls._usage_int(usage, "prompt_tokens")
        tokens_out = cls._usage_int(usage, "completion_tokens")
        cache_hit_tokens = cls._usage_int(usage, "prompt_cache_hit_tokens")
        cache_miss_tokens = cls._usage_int(usage, "prompt_cache_miss_tokens")

        # DeepSeek bills input tokens differently depending on context-cache hits.
        # Older or proxied responses may omit one/both cache fields; keep totals
        # consistent and conservatively treat unknown input tokens as cache misses.
        if cache_hit_tokens or cache_miss_tokens:
            known_input_tokens = cache_hit_tokens + cache_miss_tokens
            if tokens_in > known_input_tokens:
                cache_miss_tokens += tokens_in - known_input_tokens
            elif tokens_in == 0:
                tokens_in = known_input_tokens
        else:
            cache_miss_tokens = tokens_in

        return {
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "cache_hit_tokens": cache_hit_tokens,
            "cache_miss_tokens": cache_miss_tokens,
        }

    @staticmethod
    def _estimate_cost(
        *,
        model: str,
        tokens_in: int,
        tokens_out: int,
        cache_hit_tokens: int = 0,
        cache_miss_tokens: int | None = None,
    ) -> float:
        pricing = DEEPSEEK_PRICING_PER_1M_TOKENS.get(
            model, DEFAULT_DEEPSEEK_PRICING_PER_1M_TOKENS
        )
        billable_cache_miss_tokens = (
            max(0, tokens_in - cache_hit_tokens)
            if cache_miss_tokens is None
            else cache_miss_tokens
        )
        return round(
            (cache_hit_tokens / 1_000_000) * pricing["cache_hit_input"]
            + (billable_cache_miss_tokens / 1_000_000) * pricing["cache_miss_input"]
            + (tokens_out / 1_000_000) * pricing["output"],
            6,
        )

    @staticmethod
    def estimate_prompt_cost_usd(model: str, prompt: str) -> float:
        pricing = DEEPSEEK_PRICING_PER_1M_TOKENS.get(
            model, DEFAULT_DEEPSEEK_PRICING_PER_1M_TOKENS
        )
        prompt_tokens = max(1, math.ceil(len(prompt) / 4))
        expected_output_tokens = 1800
        return round(
            (prompt_tokens / 1_000_000) * pricing["cache_miss_input"]
            + (expected_output_tokens / 1_000_000) * pricing["output"],
            6,
        )
