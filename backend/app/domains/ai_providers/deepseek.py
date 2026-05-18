from __future__ import annotations

import datetime
import json
import logging

from openai import OpenAI

from app.core.config import settings
from app.domains.ai_providers.base import AIProviderResponse, BaseAIProvider
from app.domains.ai_providers.tools import web_search as web_search_tool

logger = logging.getLogger("app")

DEEPSEEK_PRICING_PER_1M_TOKENS = {
    "deepseek-v4-flash": {"input": 0.14, "output": 0.28},
    "deepseek-v4-pro": {"input": 0.435, "output": 0.87},
}

current_date = datetime.datetime.now().strftime("%Y-%m-%d")

_SYSTEM_MESSAGE: dict = {
    "role": "system",
    "content": (
        "You have access to a web_search tool that fetches live data from the internet. "
        "ALWAYS use it to get current stock prices, market indices, news, and any "
        "real-time information before making analysis or recommendations. "
        "Never rely on your training data for current prices or market levels. "
        f"Current date: {current_date}. "
        "Always respond with valid JSON."
    ),
}

_MAX_TOOL_ROUNDS = 8


class DeepSeekProvider(BaseAIProvider):
    provider_name = "deepseek"
    supported_models = list(DEEPSEEK_PRICING_PER_1M_TOKENS.keys())

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

    def generate(self, *, prompt: str, model: str) -> AIProviderResponse:
        if model not in self.supported_models:
            model = "deepseek-v4-flash"

        SYSTEM_MESSAGE = _SYSTEM_MESSAGE.copy()
        # SYSTEM_MESSAGE["content"] = _SYSTEM_MESSAGE["content"].replace("{{current_date}}", current_date).replace("{{model}}", model)

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
        content = ""

        logger.info(f"DeepSeek request with kwargs: {kwargs}")
        for round_num in range(_MAX_TOOL_ROUNDS):
            response = self.client.chat.completions.create(**kwargs)
            logger.info(f"DeepSeek response round {round_num + 1}: {response}")
            usage = getattr(response, "usage", None)
            total_tokens_in += getattr(usage, "prompt_tokens", 0) or 0
            total_tokens_out += getattr(usage, "completion_tokens", 0) or 0

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
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result,
                })

            kwargs["messages"] = messages

        return AIProviderResponse(
            content=content.strip(),
            tokens_in=total_tokens_in,
            tokens_out=total_tokens_out,
            cost=self._estimate_cost(
                model=model, tokens_in=total_tokens_in, tokens_out=total_tokens_out
            ),
            provider=self.provider_name,
            model=model,
        )

    @staticmethod
    def _estimate_cost(*, model: str, tokens_in: int, tokens_out: int) -> float:
        pricing = DEEPSEEK_PRICING_PER_1M_TOKENS.get(model, {"input": 0.14, "output": 0.28})
        return round(
            (tokens_in / 1_000_000) * pricing["input"]
            + (tokens_out / 1_000_000) * pricing["output"],
            6,
        )
