from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, desc, select
from sqlalchemy.ext.asyncio import AsyncSession
import re

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User
from app.domains.jobs.models import Job
from app.infrastructure.database.session import get_async_db
from app.domains.fx_rates.service import load_persisted_usd_inr_rate
from app.domains.ai_providers.availability import get_recent_target_availability
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


def _normalize_prompt_for_cost_match(prompt: str | None) -> str:
    return re.sub(r"\s+", " ", (prompt or "").strip())


def _coerce_cost(value: object) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _normalize_string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        candidate = item.strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        normalized.append(candidate)
    return normalized


def _resolve_recent_model_costs(
    rows: list[tuple[object, str | None, str | None, int]],
    *,
    prompt_text: str,
    current_user_id: int,
) -> tuple[float | None, float | None]:
    normalized_prompt = _normalize_prompt_for_cost_match(prompt_text)
    exact_prompt_cost: float | None = None
    latest_model_cost: float | None = None

    for estimated_cost, response, row_prompt, row_user_id in rows:
        if not _is_likely_valid_run_output(response):
            continue

        cost = _coerce_cost(estimated_cost)
        if cost is None:
            continue

        if latest_model_cost is None:
            latest_model_cost = cost

        if (
            normalized_prompt
            and row_user_id == current_user_id
            and _normalize_prompt_for_cost_match(row_prompt) == normalized_prompt
        ):
            exact_prompt_cost = cost
            break

    return exact_prompt_cost, latest_model_cost


@router.get("")
async def list_providers(
    prompt: str = Query(default="", max_length=10000),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    base = ProviderFactory.list_providers()
    fx = await load_persisted_usd_inr_rate()
    usd_inr_rate = fx.valid_value
    prompt_text = (prompt or "").strip()
    recent_model_limit = 80 if prompt_text else 20
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
        model_last_run_web_search_used: dict[str, bool | None] = {}
        model_last_run_web_search_queries: dict[str, list[str]] = {}
        model_last_run_web_sources: dict[str, list[str]] = {}
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
            is_compatible, reason = ProviderFactory.model_compatibility(
                provider["name"], model
            )
            if is_compatible and not provider["configured"]:
                is_compatible = False
                reason = (
                    f"Provider '{provider['name']}' is not configured on this server."
                )
            if is_compatible:
                availability = await get_recent_target_availability(
                    db,
                    provider["name"],
                    model,
                )
                if not availability.available:
                    is_compatible = False
                    reason = availability.reason
            compatibility[model] = {
                "compatible": is_compatible,
                "reason": reason,
            }
            if is_compatible:
                compatible_models.append(model)

            # Primary source of truth: latest successful run for this exact model.
            # This keeps estimate badges aligned to actual recent behavior.
            latest_model_stmt = (
                select(Job.estimated_cost, Job.response, Job.prompt, Job.user_id)
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
                .limit(recent_model_limit)
            )
            latest_model_rows = (await db.execute(latest_model_stmt)).all()
            exact_prompt_cost, latest_model_cost = _resolve_recent_model_costs(
                latest_model_rows,
                prompt_text=prompt_text,
                current_user_id=current_user.id,
            )
            latest_web_stmt = (
                select(Job.web_search_used, Job.web_search_queries, Job.web_sources)
                .where(
                    and_(
                        Job.provider == provider["name"],
                        Job.model == model,
                        Job.status == JobStatus.COMPLETED,
                    )
                )
                .order_by(desc(Job.id))
                .limit(1)
            )
            latest_web_row = (await db.execute(latest_web_stmt)).first()
            if latest_web_row is not None:
                web_search_used, web_search_queries, web_sources = latest_web_row
                model_last_run_web_search_used[model] = (
                    bool(web_search_used) if web_search_used is not None else None
                )
                model_last_run_web_search_queries[model] = _normalize_string_list(
                    web_search_queries
                )
                model_last_run_web_sources[model] = _normalize_string_list(
                    web_sources
                )

            if exact_prompt_cost is not None:
                usd = exact_prompt_cost
            elif latest_model_cost is not None:
                usd = latest_model_cost
            else:
                # Fallback 1: estimator by prompt + model.
                estimator = estimators.get(provider["name"])
                usd = estimator(model, prompt_text) if estimator else 0.0
                # Fallback 2: provider recent average if estimator is unknown/zero.
                if usd <= 0 and provider_fallback_usd > 0:
                    usd = provider_fallback_usd

            model_estimated_cost_usd[model] = round(usd, 6)
            if usd_inr_rate is not None:
                model_estimated_cost_inr[model] = round(usd * usd_inr_rate, 2)
        provider["model_estimated_cost_usd"] = model_estimated_cost_usd
        provider["model_estimated_cost_inr"] = model_estimated_cost_inr
        provider["fx"] = {
            "pair": "USD/INR",
            "value": usd_inr_rate,
            "source": fx.source,
            "as_of": fx.as_of,
            "age_seconds": fx.age_seconds,
            "stale_after_seconds": fx.stale_after_seconds,
            "status": fx.status,
        }
        provider["model_compatibility"] = compatibility
        provider["compatible_models"] = compatible_models
        provider["model_last_run_web_search_used"] = model_last_run_web_search_used
        provider["model_last_run_web_search_queries"] = model_last_run_web_search_queries
        provider["model_last_run_web_sources"] = model_last_run_web_sources
    return base
