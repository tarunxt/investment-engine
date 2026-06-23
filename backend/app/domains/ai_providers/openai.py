from __future__ import annotations

import datetime
import json
import math
import re

from openai import OpenAI

from app.core.config import settings
from app.domains.ai_providers.base import (
    AIProviderResponse,
    BaseAIProvider,
)
from app.domains.ai_providers.tools import web_search as web_search_tool
from app.domains.ai_providers.web_metadata import (
    extract_web_search_sources,
    merge_web_metadata,
)

MODEL_PRICING_PER_1M_TOKENS = {
    "gpt-4o-mini": {
        "input": 0.15,
        "output": 0.60,
    },
    "gpt-4o": {
        "input": 2.50,
        "output": 10.00,
    },
}

SUPPORTED_MODELS = [
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.5-preview",
    "o4-mini",
    "o3",
    "o3-mini",
]


class OpenAIProvider(BaseAIProvider):
    provider_name = "openai"

    supported_models = SUPPORTED_MODELS
    _max_tool_rounds = 8

    @classmethod
    def is_configured(cls) -> bool:
        return bool(settings.openai_api_key)

    def __init__(self) -> None:
        if not settings.openai_api_key:
            raise ValueError("OPENAI_API_KEY is not configured")

        self.client = OpenAI(
            api_key=settings.openai_api_key,
        )

    def generate(
        self,
        *,
        prompt: str,
        model: str,
    ) -> AIProviderResponse:
        if self._requires_live_web_context(prompt):
            return self._generate_with_tools(prompt=prompt, model=model)

        return self._generate_simple(prompt=prompt, model=model)

    def _generate_simple(
        self,
        *,
        prompt: str,
        model: str,
    ) -> AIProviderResponse:

        response = self.client.responses.create(
            model=model,
            input=prompt,
        )

        usage = getattr(response, "usage", None)

        tokens_in = getattr(usage, "input_tokens", 0) or 0
        tokens_out = getattr(usage, "output_tokens", 0) or 0

        content = (response.output_text or "").strip()

        needs_table = self._requires_table_output(prompt)
        needs_stock_recommendation_table = self._requires_stock_recommendation_output(prompt)
        if needs_table and not self._looks_like_markdown_table(content):
            minimum_rows = 5 if needs_stock_recommendation_table else 1
            rewrite = self.client.responses.create(
                model=model,
                input=(
                    "Return ONLY one valid markdown table. "
                    "No preamble, no explanation, no code fences. "
                    f"Include header row, separator row, and at least {minimum_rows} data row"
                    f"{'' if minimum_rows == 1 else 's'}.\n\n"
                    f"Original user request:\n{prompt}\n\n"
                    f"Previous assistant output:\n{content}"
                ),
            )
            rewrite_usage = getattr(rewrite, "usage", None)
            tokens_in += getattr(rewrite_usage, "input_tokens", 0) or 0
            tokens_out += getattr(rewrite_usage, "output_tokens", 0) or 0
            rewritten = (rewrite.output_text or "").strip()
            if rewritten:
                content = rewritten

        return AIProviderResponse(
            content=content,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost=self._estimate_cost(
                model=model,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
            ),
            provider=self.provider_name,
            model=model,
            web_search_used=False,
            web_search_queries=[],
            web_sources=[],
        )

    def _generate_with_tools(
        self,
        *,
        prompt: str,
        model: str,
    ) -> AIProviderResponse:
        current_date = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        messages: list[dict] = [
            {
                "role": "system",
                "content": (
                    "You have access to a web_search tool that fetches live information from the web. "
                    "When the user asks for current, latest, live, or fresh market context, you must use "
                    "the tool before finalizing the answer. Do not rely on stale training-data memory for "
                    "current prices, earnings dates, market breadth, or macro levels. "
                    "If search results are empty, generic, or weak, reformulate the query with the ticker/symbol, "
                    "official company or investor-relations wording, and event-specific keywords before concluding "
                    "that no data exists. Current UTC date: "
                    f"{current_date}."
                ),
            },
            {
                "role": "user",
                "content": prompt,
            },
        ]

        tokens_in = 0
        tokens_out = 0
        content = ""
        web_search_used = False
        web_search_queries: list[str] = []
        web_sources: list[str] = []

        for _round in range(self._max_tool_rounds):
            response = self.client.chat.completions.create(
                model=model,
                messages=messages,
                tools=web_search_tool.TOOL_DEFINITIONS,
                tool_choice="auto",
            )
            usage = getattr(response, "usage", None)
            tokens_in += getattr(usage, "prompt_tokens", 0) or getattr(usage, "input_tokens", 0) or 0
            tokens_out += getattr(usage, "completion_tokens", 0) or getattr(usage, "output_tokens", 0) or 0

            choices = getattr(response, "choices", []) or []
            if not choices:
                break

            message = choices[0].message
            tool_calls = getattr(message, "tool_calls", None) or []
            if not tool_calls:
                content = (getattr(message, "content", "") or "").strip()
                break

            messages.append(
                {
                    "role": "assistant",
                    "content": getattr(message, "content", "") or "",
                    "tool_calls": [
                        {
                            "id": tool_call.id,
                            "type": "function",
                            "function": {
                                "name": tool_call.function.name,
                                "arguments": tool_call.function.arguments,
                            },
                        }
                        for tool_call in tool_calls
                    ],
                }
            )

            for tool_call in tool_calls:
                arguments = self._safe_tool_arguments(tool_call.function.arguments)
                result = web_search_tool.execute(tool_call.function.name, arguments)
                query = arguments.get("query")
                web_search_used, web_search_queries, web_sources = merge_web_metadata(
                    web_search_used,
                    web_search_queries,
                    web_sources,
                    response_used=True,
                    response_queries=[query] if isinstance(query, str) and query.strip() else None,
                    response_sources=extract_web_search_sources(result),
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": result,
                    }
                )

        if not content:
            raise RuntimeError(f"{self.provider_name}/{model} returned empty output after tool-assisted generation")

        needs_table = self._requires_table_output(prompt)
        needs_stock_recommendation_table = self._requires_stock_recommendation_output(prompt)
        if needs_table and not self._looks_like_markdown_table(content):
            minimum_rows = 5 if needs_stock_recommendation_table else 1
            rewrite = self.client.responses.create(
                model=model,
                input=(
                    "Return ONLY one valid markdown table. "
                    "No preamble, no explanation, no code fences. "
                    f"Include header row, separator row, and at least {minimum_rows} data row"
                    f"{'' if minimum_rows == 1 else 's'}.\n\n"
                    f"Original user request:\n{prompt}\n\n"
                    f"Previous assistant output:\n{content}"
                ),
            )
            rewrite_usage = getattr(rewrite, "usage", None)
            tokens_in += getattr(rewrite_usage, "input_tokens", 0) or 0
            tokens_out += getattr(rewrite_usage, "output_tokens", 0) or 0
            rewritten = (rewrite.output_text or "").strip()
            if rewritten:
                content = rewritten

        return AIProviderResponse(
            content=content,
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
    def _requires_table_output(prompt: str) -> bool:
        text = (prompt or "").lower()
        return (
            "return only one markdown table" in text
            or OpenAIProvider._requires_stock_recommendation_output(prompt)
        )

    @staticmethod
    def _requires_stock_recommendation_output(prompt: str) -> bool:
        text = (prompt or "").lower()
        return "table columns:" in text or ("stock name" in text and "units to buy" in text)

    @staticmethod
    def _requires_live_web_context(prompt: str) -> bool:
        text = (prompt or "").lower()
        if "[enable_web_search]" in text:
            return True
        keywords = (
            "latest available market data",
            "latest market data",
            "latest available",
            "latest data",
            "latest news",
            "live price",
            "earnings updates",
            "market breadth",
            "sector rotation",
            "macro conditions",
            "institutional flow",
            "current portfolio",
            "current market",
            "today",
        )
        return any(keyword in text for keyword in keywords)

    @staticmethod
    def _looks_like_markdown_table(content: str) -> bool:
        lines = [line.strip() for line in (content or "").splitlines() if line.strip()]
        pipe_lines = [line for line in lines if line.count("|") >= 2]
        if len(pipe_lines) < 3:
            return False
        has_sep = any(re.fullmatch(r"\|?[\s:\-|\t]+\|?", line) for line in pipe_lines)
        return has_sep

    @staticmethod
    def _safe_tool_arguments(arguments: str | None) -> dict:
        if not arguments:
            return {}
        try:
            parsed = json.loads(arguments)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}

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
        pricing = MODEL_PRICING_PER_1M_TOKENS.get(model, {"input": 0.15, "output": 0.60})
        prompt_tokens = max(1, math.ceil(len(prompt) / 4))
        expected_output_tokens = 1800
        return round(
            (prompt_tokens / 1_000_000) * pricing["input"]
            + (expected_output_tokens / 1_000_000) * pricing["output"],
            6,
        )
