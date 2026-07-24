from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.ai_providers.availability import get_recent_target_availability
from app.domains.ai_providers.factory import ProviderFactory
from app.domains.portfolio_events.schemas import PortfolioEventRunRequest


async def resolve_portfolio_analysis_target(
    body: PortfolioEventRunRequest | None,
    *,
    db: AsyncSession,
    default_provider: str,
    default_model: str,
    analysis_label: str,
) -> tuple[str, str]:
    using_default_target = body is None or (body.provider is None and body.model is None)

    if using_default_target:
        blocked_reasons: list[str] = []
        for provider, model in ProviderFactory.default_target_candidates(
  default_provider,
  default_model,
        ):
  availability = await get_recent_target_availability(db, provider, model)
  if availability.available:
      return provider, model
  if availability.reason:
      blocked_reasons.append(availability.reason)
        detail = f"No configured AI provider is currently available for {analysis_label} analysis."
        if blocked_reasons:
  detail = f"{detail} {blocked_reasons[0]}"
        raise HTTPException(503, detail=detail)

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

    availability = await get_recent_target_availability(db, provider, model)
    if not availability.available:
        raise HTTPException(
  503,
  detail=availability.reason or f"{provider}/{model} is temporarily unavailable.",
        )

    return provider, model
