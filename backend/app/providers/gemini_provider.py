from __future__ import annotations

import os

from google import genai
from google.genai import types

from app.core.config import settings
from app.providers.base import AIProviderResponse, BaseAIProvider


MODEL_PRICING_PER_1M_TOKENS = {
    "gemini-3.1-flash-lite": {"input": 0.10, "output": 0.40},
    "gemini-3.1-pro-preview": {"input": 1.25, "output": 5.00},
}


class GeminiProvider(BaseAIProvider):
    provider_name = "gemini"
    supported_models = ["gemini-3.1-flash-lite", "gemini-3.1-pro-preview"]

    @classmethod
    def is_configured(cls) -> bool:
        return bool(settings.gemini_api_key)

    def __init__(self) -> None:
        if not settings.gemini_api_key:
            raise ValueError("GEMINI_API_KEY is not configured")

        self.api_key = settings.gemini_api_key

    def generate(self, *, prompt: str, model: str) -> AIProviderResponse:
        client = genai.Client(api_key=self.api_key)

        contents = [
            types.Content(
                role="user",
                parts=[
                    types.Part.from_text(text=prompt),
                ],
            ),
        ]

        generate_content_config = types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(
                thinking_level=types.ThinkingLevel.MINIMAL,
            ),
            tools=[
                types.Tool(
                    google_search=types.GoogleSearch()
                )
            ],
        )

        full_text = ""
        usage_metadata = None

        for chunk in client.models.generate_content_stream(
            model=model,
            contents=contents,
            config=generate_content_config,
        ):
            if chunk.text:
                full_text += chunk.text

            if getattr(chunk, "usage_metadata", None):
                usage_metadata = chunk.usage_metadata

        tokens_in = int(getattr(usage_metadata, "prompt_token_count", 0) or 0)
        tokens_out = int(getattr(usage_metadata, "candidates_token_count", 0) or 0)

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
        )

    @staticmethod
    def _estimate_cost(*, model: str, tokens_in: int, tokens_out: int) -> float:
        pricing = MODEL_PRICING_PER_1M_TOKENS.get(model)

        if not pricing:
            return 0.0

        estimated_cost = (
            (tokens_in / 1_000_000) * pricing["input"]
            + (tokens_out / 1_000_000) * pricing["output"]
        )

        return round(estimated_cost, 6)