from __future__ import annotations

from app.domains.ai_providers.anthropic import AnthropicProvider
from app.domains.ai_providers.base import BaseAIProvider
from app.domains.ai_providers.deepseek import DeepSeekProvider
from app.domains.ai_providers.gemini import GeminiProvider
from app.domains.ai_providers.openai import OpenAIProvider


class ProviderFactory:
    _providers: dict[str, type[BaseAIProvider]] = {
        AnthropicProvider.provider_name: AnthropicProvider,
        GeminiProvider.provider_name: GeminiProvider,
        OpenAIProvider.provider_name: OpenAIProvider,
        DeepSeekProvider.provider_name: DeepSeekProvider,
    }

    @classmethod
    def create(cls, provider_name: str) -> BaseAIProvider:
        key = provider_name.strip().lower()
        provider_class = cls._providers.get(key)
        if not provider_class:
            supported = ", ".join(sorted(cls._providers))
            raise ValueError(
                f"Unsupported AI provider '{provider_name}'. Supported: {supported}"
            )
        return provider_class()

    @classmethod
    def supports(cls, provider_name: str) -> bool:
        return provider_name.strip().lower() in cls._providers

    @classmethod
    def is_configured(cls, provider_name: str) -> bool:
        provider_class = cls._providers.get(provider_name.strip().lower())
        return provider_class is not None and provider_class.is_configured()

    @classmethod
    def list_providers(cls) -> list[dict]:
        return [
            {
                "name": name,
                "models": provider_class.supported_models,
                "configured": provider_class.is_configured(),
            }
            for name, provider_class in cls._providers.items()
        ]
