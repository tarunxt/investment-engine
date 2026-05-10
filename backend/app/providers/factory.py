from __future__ import annotations

from app.providers.base import BaseAIProvider
from app.providers.gemini_provider import GeminiProvider
from app.providers.openai_provider import OpenAIProvider
from app.providers.deepseek_provider import DeepSeekProvider


class ProviderFactory:
    _providers: dict[str, type[BaseAIProvider]] = {
        GeminiProvider.provider_name: GeminiProvider,
        OpenAIProvider.provider_name: OpenAIProvider,
        DeepSeekProvider.provider_name: DeepSeekProvider,
    }

    @classmethod
    def create(cls, provider_name: str) -> BaseAIProvider:
        normalized_name = provider_name.strip().lower()
        provider_class = cls._providers.get(normalized_name)
        if not provider_class:
            supported_providers = ", ".join(sorted(cls._providers))
            raise ValueError(
                f"Unsupported AI provider '{provider_name}'. Supported providers: {supported_providers}"
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
