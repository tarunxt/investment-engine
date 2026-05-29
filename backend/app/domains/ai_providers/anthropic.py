from __future__ import annotations

import math

import anthropic
from anthropic.types import TextBlock

from app.core.config import settings
from app.domains.ai_providers.base import AIProviderResponse, BaseAIProvider

MODEL_PRICING_PER_1M_TOKENS = {
    "claude-opus-4-7": {"input": 15.00, "output": 75.00},
    "claude-sonnet-4-6": {"input": 3.00, "output": 15.00},
}

SUPPORTED_MODELS = [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-3-7-sonnet-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-latest",
    "claude-3-opus-latest",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307",
]


class AnthropicProvider(BaseAIProvider):
    provider_name = "anthropic"
    supported_models = SUPPORTED_MODELS

    @classmethod
    def is_configured(cls) -> bool:
        return bool(settings.anthropic_api_key)

    def __init__(self) -> None:
        if not settings.anthropic_api_key:
            raise ValueError("ANTHROPIC_API_KEY is not configured")
        self.client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    def generate(self, *, prompt: str, model: str) -> AIProviderResponse:
        response = self.client.messages.create(
            model=model,
            max_tokens=8096,
            messages=[
                {"role": "user", "content": prompt},
            ],
        )

        raw = next((b.text for b in response.content if isinstance(b, TextBlock)), "")
        content = "{" + raw  # restore the prefill character Anthropic strips from the reply

        usage = response.usage
        tokens_in = getattr(usage, "input_tokens", 0) or 0
        tokens_out = getattr(usage, "output_tokens", 0) or 0

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
    def _estimate_cost(*, model: str, tokens_in: int, tokens_out: int) -> float:
        pricing = MODEL_PRICING_PER_1M_TOKENS.get(model, {"input": 3.00, "output": 15.00})
        return round(
            (tokens_in / 1_000_000) * pricing["input"]
            + (tokens_out / 1_000_000) * pricing["output"],
            6,
        )

    @staticmethod
    def estimate_prompt_cost_usd(model: str, prompt: str) -> float:
        pricing = MODEL_PRICING_PER_1M_TOKENS.get(model, {"input": 3.00, "output": 15.00})
        prompt_tokens = max(1, math.ceil(len(prompt) / 4))
        expected_output_tokens = 1800
        return round(
            (prompt_tokens / 1_000_000) * pricing["input"]
            + (expected_output_tokens / 1_000_000) * pricing["output"],
            6,
        )
