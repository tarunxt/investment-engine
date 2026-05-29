from __future__ import annotations

import math

from google import genai
from google.genai import types

from app.core.config import settings
from app.domains.ai_providers.base import (
    AIProviderResponse,
    BaseAIProvider,
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
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-3-flash-preview",
]


class GeminiProvider(BaseAIProvider):
    provider_name = "gemini"

    supported_models = SUPPORTED_MODELS

    @classmethod
    def is_configured(cls) -> bool:
        return bool(settings.gemini_api_key or settings.gemini_api_key_fallback)

    def __init__(self) -> None:
        self._api_keys = [k for k in [settings.gemini_api_key, settings.gemini_api_key_fallback] if k]
        if not self._api_keys:
            raise ValueError(
                "GEMINI_API_KEY is not configured"
            )
        self.client = genai.Client(api_key=self._api_keys[0])

    def generate(
        self,
        *,
        prompt: str,
        model: str,
    ) -> AIProviderResponse:
        last_error: Exception | None = None
        for api_key in self._api_keys:
            try:
                self.client = genai.Client(api_key=api_key)
                return self._generate_once(prompt=prompt, model=model)
            except Exception as exc:
                last_error = exc
                msg = str(exc).lower()
                should_fallback = any(code in msg for code in ["429", "quota", "rate limit", "resource_exhausted"])
                if not should_fallback:
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

        # thinking_level = (
        #     types.ThinkingLevel.HIGH
        #     if model == "gemini-3.1-pro-preview"
        #     else types.ThinkingLevel.MINIMAL
        # )

        tools: list[types.Tool] = []

        tools.append(
            types.Tool(
                google_search=types.GoogleSearch()
            )
        )

        config = types.GenerateContentConfig(
            # thinking_config=types.ThinkingConfig(
            #     thinking_level=thinking_level,
            # ),
            temperature=0.7,
            max_output_tokens=3500,
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
        max_chars = 18000

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

    @staticmethod
    def estimate_prompt_cost_usd(model: str, prompt: str) -> float:
        pricing = MODEL_PRICING_PER_1M_TOKENS.get(model)
        if not pricing:
            return 0.0
        prompt_tokens = max(1, math.ceil(len(prompt) / 4))
        expected_output_tokens = 1800
        return round(
            (prompt_tokens / 1_000_000) * pricing["input"]
            + (expected_output_tokens / 1_000_000) * pricing["output"],
            6,
        )
