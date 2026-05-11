from __future__ import annotations

from openai import OpenAI

from app.core.config import settings
from app.domains.ai_providers.base import AIProviderResponse, BaseAIProvider

DEEPSEEK_PRICING_PER_1M_TOKENS = {
    "deepseek-v4-flash": {"input": 0.14, "output": 0.28},
    "deepseek-v4-pro": {"input": 0.435, "output": 0.87},
}


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
            model = "deepseek-v4-flash"  # default to flash if unknown model requested

        kwargs: dict = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
        }
        if model == "deepseek-v4-pro":
            kwargs["reasoning_effort"] = "high"

        response = self.client.chat.completions.create(**kwargs)
        usage = getattr(response, "usage", None)
        tokens_in = getattr(usage, "prompt_tokens", 0) or 0
        tokens_out = getattr(usage, "completion_tokens", 0) or 0
        choices = getattr(response, "choices", []) or []
        content = ""
        if choices:
            message = getattr(choices[0], "message", None)
            content = getattr(message, "content", "") or ""
            if model == "deepseek-v4-pro":
                reasoning = getattr(message, "reasoning_content", "") or ""
                if reasoning:
                    content = f"<thinking>\n{reasoning}\n</thinking>\n\n{content}"

        return AIProviderResponse(
            content=content.strip(),
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost=self._estimate_cost(model=model, tokens_in=tokens_in, tokens_out=tokens_out),
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
