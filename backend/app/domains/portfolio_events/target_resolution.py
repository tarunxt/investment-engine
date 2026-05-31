from __future__ import annotations

from fastapi import HTTPException

from app.domains.ai_providers.factory import ProviderFactory
from app.domains.portfolio_events.schemas import PortfolioEventRunRequest


def resolve_portfolio_analysis_target(
    body: PortfolioEventRunRequest | None,
    *,
    default_provider: str,
    default_model: str,
    analysis_label: str,
) -> tuple[str, str]:
    using_default_target = body is None or (body.provider is None and body.model is None)

    if using_default_target:
        target = ProviderFactory.resolve_default_target(default_provider, default_model)
        if target:
            return target
        raise HTTPException(
            503,
            detail=f"No configured AI provider is available on this server for {analysis_label} analysis.",
        )

    provider = body.provider or default_provider
    model = body.model or default_model

    if not ProviderFactory.supports(provider):
        raise HTTPException(400, detail=f"Unsupported provider: '{provider}'")

    if not ProviderFactory.is_configured(provider):
        raise HTTPException(503, detail=f"Provider '{provider}' is not configured on this server")

    provider_instance = ProviderFactory.create(provider)
    if model not in provider_instance.supported_models:
        raise HTTPException(
            400,
            detail=f"Model '{model}' is not supported for provider '{provider}'",
        )

    is_compatible, reason = ProviderFactory.model_compatibility(provider, model)
    if not is_compatible:
        raise HTTPException(
            400,
            detail=(
                f"Model '{model}' for provider '{provider}' is unavailable. "
                f"{reason or f'Please choose another compatible {analysis_label} model.'}"
            ),
        )

    return provider, model
