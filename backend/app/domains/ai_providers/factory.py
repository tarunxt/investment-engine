from __future__ import annotations

from typing import Literal, TypedDict

from app.domains.ai_providers.anthropic import AnthropicProvider
from app.domains.ai_providers.base import BaseAIProvider
from app.domains.ai_providers.deepseek import DeepSeekProvider
from app.domains.ai_providers.gemini import GeminiProvider
from app.domains.ai_providers.openai import OpenAIProvider


InternetAccessMode = Literal["always_enabled", "tool_auto", "conditional", "none"]


class InternetAccessInfo(TypedDict, total=False):
    mode: InternetAccessMode
    label: str
    force_token: str
    caveat: str


class ProviderFactory:
    _default_provider_priority: tuple[str, ...] = (
        "openai",
        "gemini",
        "deepseek",
        "anthropic",
    )
    _providers: dict[str, type[BaseAIProvider]] = {
        AnthropicProvider.provider_name: AnthropicProvider,
        GeminiProvider.provider_name: GeminiProvider,
        OpenAIProvider.provider_name: OpenAIProvider,
        DeepSeekProvider.provider_name: DeepSeekProvider,
    }
    _provider_internet_access: dict[str, InternetAccessInfo] = {
        "openai": {
            "mode": "conditional",
            "label": "Search only if forced",
            "force_token": "[enable_web_search]",
            "caveat": (
                "The OpenAI adapter enables live web tools when the prompt asks for "
                "current context or explicitly includes [enable_web_search]."
            ),
        },
        "gemini": {
            "mode": "always_enabled",
            "label": "Search attached",
            "caveat": (
                "The Gemini adapter attaches Google Search by default for normal runs. "
                "Repair prompts disable search to keep output formatting deterministic."
            ),
        },
        "deepseek": {
            "mode": "tool_auto",
            "label": "Can search, not guaranteed",
            "caveat": (
                "The DeepSeek adapter exposes a custom web_search tool with tool_choice=auto. "
                "Whether search actually ran must be verified from the saved run metadata."
            ),
        },
        "anthropic": {
            "mode": "none",
            "label": "No model-side search",
            "caveat": (
                "The Anthropic adapter currently sends plain messages.create requests "
                "without any web or search tools."
            ),
        },
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
                "internet_access": cls.get_provider_internet_access(name),
            }
            for name, provider_class in cls._providers.items()
        ]

    @classmethod
    def get_provider_internet_access(cls, provider_name: str) -> InternetAccessInfo:
        key = provider_name.strip().lower()
        access = cls._provider_internet_access.get(
            key,
            {
                "mode": "none",
                "label": "No live web",
                "caveat": "No live web metadata is configured for this provider.",
            },
        )
        return dict(access)

    @classmethod
    def model_compatibility(cls, provider_name: str, model: str) -> tuple[bool, str | None]:
        provider = provider_name.strip().lower()
        model_name = model.strip()
        reason = cls._incompatible_models.get(provider, {}).get(model_name)
        if reason:
            return False, reason
        return True, None

    @classmethod
    def resolve_default_target(
        cls,
        preferred_provider: str,
        preferred_model: str,
    ) -> tuple[str, str] | None:
        provider_name = preferred_provider.strip().lower()
        model_name = preferred_model.strip()

        resolved = cls._resolve_target_for_provider(provider_name, preferred_model=model_name)
        if resolved:
            return resolved

        for candidate_provider in cls._ordered_provider_names(preferred_provider=provider_name):
            if candidate_provider == provider_name:
                continue
            resolved = cls._resolve_target_for_provider(candidate_provider)
            if resolved:
                return resolved

        return None

    @classmethod
    def _resolve_target_for_provider(
        cls,
        provider_name: str,
        *,
        preferred_model: str | None = None,
    ) -> tuple[str, str] | None:
        provider = provider_name.strip().lower()
        provider_class = cls._providers.get(provider)
        if provider_class is None or not provider_class.is_configured():
            return None

        if preferred_model:
            normalized_model = preferred_model.strip()
            if normalized_model in provider_class.supported_models:
                is_compatible, _ = cls.model_compatibility(provider, normalized_model)
                if is_compatible:
                    return provider, normalized_model

        for model_name in provider_class.supported_models:
            is_compatible, _ = cls.model_compatibility(provider, model_name)
            if is_compatible:
                return provider, model_name

        return None

    @classmethod
    def _ordered_provider_names(cls, *, preferred_provider: str | None = None) -> list[str]:
        ordered: list[str] = []
        normalized_preferred = preferred_provider.strip().lower() if preferred_provider else None

        if normalized_preferred and normalized_preferred in cls._providers:
            ordered.append(normalized_preferred)

        for provider_name in cls._default_provider_priority:
            if provider_name in cls._providers and provider_name not in ordered:
                ordered.append(provider_name)

        for provider_name in cls._providers:
            if provider_name not in ordered:
                ordered.append(provider_name)

        return ordered
