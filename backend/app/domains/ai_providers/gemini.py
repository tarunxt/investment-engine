from __future__ import annotations

from google import genai
from google.genai import types

from app.core.config import settings
from app.domains.ai_providers.base import (
    AIProviderResponse,
    BaseAIProvider,
)

MODEL_PRICING_PER_1M_TOKENS = {
    "gemini-3.1-flash-lite": {
        "input": 0.25,
        "output": 1.50,
    },
    "gemini-3.1-pro-preview": {
        "input": 1.25,
        "output": 5.00,
    },
}


class GeminiProvider(BaseAIProvider):
    provider_name = "gemini"

    supported_models = list(
        MODEL_PRICING_PER_1M_TOKENS.keys()
    )

    @classmethod
    def is_configured(cls) -> bool:
        return bool(settings.gemini_api_key)

    def __init__(self) -> None:
        if not settings.gemini_api_key:
            raise ValueError(
                "GEMINI_API_KEY is not configured"
            )

        self.client = genai.Client(
            api_key=settings.gemini_api_key,
        )

    def generate(
        self,
        *,
        prompt: str,
        model: str,
        use_search: bool = True,
    ) -> AIProviderResponse:
        tools: list[types.Tool] = []

        thinking_level = (
            types.ThinkingLevel.HIGH
            if model == "gemini-3.1-pro-preview"
            else types.ThinkingLevel.MINIMAL
        )

        tools: list[types.Tool] = []

        if use_search:
            tools.append(
                types.Tool(
                    google_search=types.GoogleSearch()
                )
            )

        config = types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(
                thinking_level=thinking_level,
            ),
            temperature=0.7,
            tools=tools if tools else None,
        )

        contents = [
            types.Content(
                role="user",
                parts=[
                    types.Part.from_text(text=prompt)
                ],
            )
        ]

        full_text_parts: list[str] = []

        usage_metadata = None

        stream = self.client.models.generate_content_stream(
            model=model,
            contents=contents,
            config=config,
        )

        for chunk in stream:

            text = getattr(chunk, "text", None)

            if text:
                full_text_parts.append(text)

            metadata = getattr(
                chunk,
                "usage_metadata",
                None,
            )

            if metadata:
                usage_metadata = metadata

        full_text = "".join(full_text_parts)

        tokens_in = int(
            getattr(
                usage_metadata,
                "prompt_token_count",
                0,
            ) or 0
        )

        tokens_out = int(
            getattr(
                usage_metadata,
                "candidates_token_count",
                0,
            ) or 0
        )

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
            (tokens_in / 1_000_000)
            * pricing["input"]
            + (tokens_out / 1_000_000)
            * pricing["output"],
            6,
        )