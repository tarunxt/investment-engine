from __future__ import annotations

import math

from openai import OpenAI

from app.core.config import settings
from app.domains.ai_providers.base import (
    AIProviderResponse,
    BaseAIProvider,
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

        response = self.client.responses.create(
            model=model,
            input=prompt,
        )

        usage = getattr(response, "usage", None)

        tokens_in = getattr(usage, "input_tokens", 0) or 0
        tokens_out = getattr(usage, "output_tokens", 0) or 0

        content = response.output_text or ""

        return AIProviderResponse(
            content=content.strip(),
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost=self._estimate_cost(
                model=model,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
            ),
            provider=self.provider_name,
            model=model,
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
        pricing = MODEL_PRICING_PER_1M_TOKENS.get(model, {"input": 0.15, "output": 0.60})
        prompt_tokens = max(1, math.ceil(len(prompt) / 4))
        expected_output_tokens = 1800
        return round(
            (prompt_tokens / 1_000_000) * pricing["input"]
            + (expected_output_tokens / 1_000_000) * pricing["output"],
            6,
        )
