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
    # Runtime compatibility snapshot for currently configured upstream APIs.
    # Models not listed here are treated as compatible by default.
    _incompatible_models: dict[str, dict[str, str]] = {
        "anthropic": {
            "claude-3-7-sonnet-latest": "Not found (404) for current Anthropic API.",
            "claude-3-5-sonnet-latest": "Not found (404) for current Anthropic API.",
            "claude-3-5-haiku-latest": "Not found (404) for current Anthropic API.",
            "claude-3-opus-latest": "Not found (404) for current Anthropic API.",
            "claude-3-sonnet-20240229": "Not found (404) for current Anthropic API.",
            "claude-3-haiku-20240307": "Not found (404) for current Anthropic API.",
        },
        "gemini": {
            "gemini-1.5-pro": "Not found (404) for current Gemini API version.",
            "gemini-1.5-flash": "Not found (404) for current Gemini API version.",
            "gemini-1.5-flash-8b": "Not found (404) for current Gemini API version.",
        },
        "openai": {
            "gpt-4.1": "Project access denied (403).",
            "gpt-4.1-mini": "Project access denied (403).",
            "gpt-4.1-nano": "Project access denied (403).",
            "gpt-4.5-preview": "Model not found.",
            "o4-mini": "Project access denied (403).",
            "o3": "Project access denied (403).",
            "o3-mini": "Project access denied (403).",
        },
        "deepseek": {
            "deepseek-r1": "Unsupported by current DeepSeek API account.",
            "deepseek-v3": "Unsupported by current DeepSeek API account.",
        },
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

    @classmethod
    def model_compatibility(cls, provider_name: str, model: str) -> tuple[bool, str | None]:
        provider = provider_name.strip().lower()
        model_name = model.strip()
        reason = cls._incompatible_models.get(provider, {}).get(model_name)
        if reason:
            return False, reason
        return True, None
