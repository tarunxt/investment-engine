from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, desc, select
from sqlalchemy.ext.asyncio import AsyncSession
import re

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.infrastructure.database.session import get_async_db
from app.domains.api_usage.router import _fetch_usd_inr_rate
from app.domains.ai_providers.factory import ProviderFactory
from app.shared.types import JobStatus
from app.domains.ai_providers.anthropic import AnthropicProvider
from app.domains.ai_providers.deepseek import DeepSeekProvider
from app.domains.ai_providers.gemini import GeminiProvider
from app.domains.ai_providers.openai import OpenAIProvider

router = APIRouter(prefix="/providers", tags=["providers"])


def _is_likely_valid_run_output(response: str | None) -> bool:
    text = (response or "").strip()
    if not text:
        return False
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    pipe_lines = [line for line in lines if line.count("|") >= 2]
    if not pipe_lines:
        return True

    def _is_separator(line: str) -> bool:
        normalized = line.replace("|", "").replace(":", "").replace("-", "").replace(" ", "")
        return normalized == ""

    data_rows = 0
    for idx, line in enumerate(pipe_lines):
        if idx == 0:
            continue
        if _is_separator(line):
            continue
        lower = line.lower()
        if "stock symbol" in lower and "technical setup" in lower:
            continue
        data_rows += 1
    if data_rows < 1:
        return False
    if len(re.findall(r"-{40,}", text)) >= 3:
        return False
    return True


@router.get("")
async def list_providers(
    prompt: str = Query(default="", max_length=10000),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    base = ProviderFactory.list_providers()
    usd_inr_rate, _ = await _fetch_usd_inr_rate()
    prompt_text = (prompt or "").strip()
    estimators = {
        "openai": OpenAIProvider.estimate_prompt_cost_usd,
        "anthropic": AnthropicProvider.estimate_prompt_cost_usd,
        "gemini": GeminiProvider.estimate_prompt_cost_usd,
        "deepseek": DeepSeekProvider.estimate_prompt_cost_usd,
    }
    for provider in base:
        compatibility: dict[str, dict[str, str | bool | None]] = {}
        compatible_models: list[str] = []
        model_estimated_cost_inr: dict[str, float] = {}
        model_estimated_cost_usd: dict[str, float] = {}
        provider_recent_costs: list[float] = []

        # Provider-level fallback from recent successful runs to avoid ₹0.00 for
        # models that have no explicit pricing map yet.
        provider_recent_stmt = (
            select(Job.estimated_cost, Job.response)
            .where(
                and_(
                    Job.provider == provider["name"],
                    Job.status == JobStatus.COMPLETED,
                    Job.estimated_cost.isnot(None),
                    Job.estimated_cost > 0,
                )
            )
            .order_by(desc(Job.id))
            .limit(20)
        )
        provider_recent_rows = (await db.execute(provider_recent_stmt)).all()
        for estimated_cost, response in provider_recent_rows:
            if not _is_likely_valid_run_output(response):
                continue
            try:
                provider_recent_costs.append(float(estimated_cost))
            except (TypeError, ValueError):
                continue
        provider_fallback_usd = (
            round(sum(provider_recent_costs) / len(provider_recent_costs), 6)
            if provider_recent_costs
            else 0.0
        )

        for model in provider["models"]:
            is_compatible, reason = ProviderFactory.model_compatibility(provider["name"], model)
            compatibility[model] = {
                "compatible": is_compatible,
                "reason": reason,
            }
            if is_compatible:
                compatible_models.append(model)

            # Primary source of truth: latest successful run for this exact model.
            # This keeps estimate badges aligned to actual recent behavior.
            latest_model_stmt = (
                select(Job.estimated_cost, Job.response)
                .where(
                    and_(
                        Job.provider == provider["name"],
                        Job.model == model,
                        Job.status == JobStatus.COMPLETED,
                        Job.estimated_cost.isnot(None),
                        Job.estimated_cost > 0,
                    )
                )
                .order_by(desc(Job.id))
                .limit(20)
            )
            latest_model_rows = (await db.execute(latest_model_stmt)).all()
            latest_model_cost: float | None = None
            for estimated_cost, response in latest_model_rows:
                if not _is_likely_valid_run_output(response):
                    continue
                try:
                    latest_model_cost = float(estimated_cost)
                    break
                except (TypeError, ValueError):
                    continue

            if latest_model_cost is not None:
                usd = latest_model_cost
            else:
                # Fallback 1: estimator by prompt + model.
                estimator = estimators.get(provider["name"])
                usd = estimator(model, prompt_text) if estimator else 0.0
                # Fallback 2: provider recent average if estimator is unknown/zero.
                if usd <= 0 and provider_fallback_usd > 0:
                    usd = provider_fallback_usd

            model_estimated_cost_usd[model] = round(usd, 6)
            model_estimated_cost_inr[model] = round(usd * usd_inr_rate, 2)
        provider["model_estimated_cost_usd"] = model_estimated_cost_usd
        provider["model_estimated_cost_inr"] = model_estimated_cost_inr
        provider["model_compatibility"] = compatibility
        provider["compatible_models"] = compatible_models
    return base
