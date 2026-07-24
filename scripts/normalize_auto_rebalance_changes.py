from pathlib import Path


def replace_between(path: str, start_marker: str, end_marker: str, replacement: str) -> None:
    file_path = Path(path)
    text = file_path.read_text()
    start = text.index(start_marker)
    end = text.index(end_marker, start)
    file_path.write_text(text[:start] + replacement + text[end:])


Path("backend/app/domains/ai_providers/availability.py").write_text(
    '''from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol, TypeVar
from zoneinfo import ZoneInfo

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.jobs.models import Job
from app.shared.types import JobStatus


CAPACITY_FAILURE_COOLDOWN = timedelta(hours=1)
IST = ZoneInfo("Asia/Kolkata")
CAPACITY_ERROR_MARKERS = (
    "insufficient balance",
    "insufficient_balance",
    "insufficient quota",
    "insufficient_quota",
    "exceeded your current quota",
    "billing hard limit",
    "billing details",
    "payment required",
    "credit balance",
    "account balance is too low",
)


class ProviderModelTarget(Protocol):
    provider: str
    model: str


TargetT = TypeVar("TargetT", bound=ProviderModelTarget)


@dataclass(frozen=True)
class TargetAvailability:
    available: bool
    reason: str | None = None
    retry_after: datetime | None = None


def is_provider_capacity_error(error: object) -> bool:
    text = str(error or "").lower()
    return any(marker in text for marker in CAPACITY_ERROR_MARKERS)


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _format_retry_after_ist(value: datetime) -> str:
    return value.astimezone(IST).strftime("%d %b %Y, %I:%M %p IST")


async def get_recent_target_availability(
    session: AsyncSession,
    provider: str,
    model: str,
    *,
    now: datetime | None = None,
) -> TargetAvailability:
    terminal_statuses = (
        JobStatus.COMPLETED,
        JobStatus.PARTIAL,
        JobStatus.FAILED,
    )
    result = await session.execute(
        select(Job)
        .where(
            Job.provider == provider,
            Job.model == model,
            Job.status.in_(terminal_statuses),
        )
        .order_by(desc(Job.id))
        .limit(1)
    )
    latest = result.scalar_one_or_none()
    if latest is None or latest.status == JobStatus.COMPLETED:
        return TargetAvailability(available=True)
    if not is_provider_capacity_error(latest.error_message):
        return TargetAvailability(available=True)

    failed_at = _as_utc(latest.updated_at or latest.created_at)
    if failed_at is None:
        return TargetAvailability(available=True)
    retry_after = failed_at + CAPACITY_FAILURE_COOLDOWN
    current_time = _as_utc(now) or datetime.now(UTC)
    if current_time >= retry_after:
        return TargetAvailability(available=True)

    return TargetAvailability(
        available=False,
        retry_after=retry_after,
        reason=(
            f"{provider}/{model} is temporarily paused after a provider billing or quota error. "
            f"Automatic retry is allowed after {_format_retry_after_ist(retry_after)}."
        ),
    )


async def filter_recently_available_targets(
    session: AsyncSession,
    targets: list[TargetT],
) -> tuple[list[TargetT], list[tuple[TargetT, TargetAvailability]]]:
    available: list[TargetT] = []
    blocked: list[tuple[TargetT, TargetAvailability]] = []
    for target in targets:
        availability = await get_recent_target_availability(
            session,
            target.provider,
            target.model,
        )
        if availability.available:
            available.append(target)
        else:
            blocked.append((target, availability))
    return available, blocked
'''
)

replace_between(
    "backend/app/domains/ai_providers/factory.py",
    "    @classmethod\n    def default_target_candidates(",
    "    @classmethod\n    def _resolve_target_for_provider(",
    '''    @classmethod
    def default_target_candidates(
        cls,
        preferred_provider: str,
        preferred_model: str,
    ) -> list[tuple[str, str]]:
        preferred_provider_name = preferred_provider.strip().lower()
        preferred_model_name = preferred_model.strip()
        candidates: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()

        def add_candidate(provider_name: str, model_name: str) -> None:
            provider = provider_name.strip().lower()
            model = model_name.strip()
            provider_class = cls._providers.get(provider)
            if provider_class is None or not provider_class.is_configured():
                return
            if model not in provider_class.supported_models:
                return
            compatible, _ = cls.model_compatibility(provider, model)
            key = (provider, model)
            if not compatible or key in seen:
                return
            seen.add(key)
            candidates.append(key)

        add_candidate(preferred_provider_name, preferred_model_name)
        for provider_name in cls._ordered_provider_names(
            preferred_provider=preferred_provider_name
        ):
            provider_class = cls._providers.get(provider_name)
            if provider_class is None or not provider_class.is_configured():
                continue
            for model_name in provider_class.supported_models:
                add_candidate(provider_name, model_name)
        return candidates

    @classmethod
    def resolve_default_target(
        cls,
        preferred_provider: str,
        preferred_model: str,
    ) -> tuple[str, str] | None:
        candidates = cls.default_target_candidates(preferred_provider, preferred_model)
        return candidates[0] if candidates else None

''',
)

replace_between(
    "backend/app/domains/ai_providers/router.py",
    '            is_compatible, reason = ProviderFactory.model_compatibility(provider["name"], model)\n',
    "            # Primary source of truth: latest successful run for this exact model.\n",
    '''            is_compatible, reason = ProviderFactory.model_compatibility(
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

''',
)

Path("backend/app/domains/portfolio_events/target_resolution.py").write_text(
    '''from __future__ import annotations

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
        detail = (
            f"No configured AI provider is currently available for {analysis_label} "
            "analysis."
        )
        if blocked_reasons:
            detail = f"{detail} {blocked_reasons[0]}"
        raise HTTPException(503, detail=detail)

    provider = body.provider or default_provider
    model = body.model or default_model

    if not ProviderFactory.supports(provider):
        raise HTTPException(400, detail=f"Unsupported provider: '{provider}'")

    if not ProviderFactory.is_configured(provider):
        raise HTTPException(
            503,
            detail=f"Provider '{provider}' is not configured on this server",
        )

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
            detail=(
                availability.reason
                or f"{provider}/{model} is temporarily unavailable."
            ),
        )

    return provider, model
'''
)

replace_between(
    "backend/app/domains/runs/use_cases/create_run.py",
    "            seen_targets.add(key)\n",
    "        now = datetime.now(timezone.utc)\n",
    '''            seen_targets.add(key)
            targets.append(target)

        targets, blocked_targets = await filter_recently_available_targets(
            self._session,
            targets,
        )
        if blocked_targets:
            logger.warning(
                "Skipping temporarily unavailable provider targets: %s",
                ", ".join(
                    f"{target.provider}/{target.model}"
                    for target, _availability in blocked_targets
                ),
            )
        if not targets:
            reasons = "; ".join(
                availability.reason
                or f"{target.provider}/{target.model} is unavailable"
                for target, availability in blocked_targets
            )
            raise ValidationException(
                "No selected AI target is currently available. " + reasons
            )

        now = datetime.now(timezone.utc)
''',
)

clean_create_job = '''        result = await use_case.execute(
            CreateJobCommand(
                prompt=prompt,
                provider=provider,
                model=model,
                user_id=UserId(current_user.id),
                auto_rebalance_portfolio=(
                    body.auto_rebalance_portfolio if body else None
                ),
                auto_rebalance_sequence=(
                    body.auto_rebalance_sequence if body else None
                ),
                auto_rebalance_label=body.auto_rebalance_label if body else None,
            )
        )
'''
for router_path in (
    "backend/app/domains/zerodha/events_router.py",
    "backend/app/domains/indmoney_us/events_router.py",
):
    replace_between(
        router_path,
        "        result = await use_case.execute(\n",
        "    finally:\n",
        clean_create_job,
    )

api_path = Path("frontend/services/api.ts")
api_text = api_path.read_text()


def replace_api_method(start_marker: str, end_marker: str, replacement: str) -> None:
    global api_text
    start = api_text.index(start_marker)
    end = api_text.index(end_marker, start)
    api_text = api_text[:start] + replacement + api_text[end:]


replace_api_method(
    "  async zerodhaRunEvents(data?: PortfolioEventRunRequest): Promise<ZerodhaEventsRunResponse> {\n",
    "  zerodhaThreatsLatest(): Promise<ZerodhaThreatLatestResponse> {\n",
    '''  async zerodhaRunEvents(
    data?: PortfolioEventRunRequest,
  ): Promise<ZerodhaEventsRunResponse> {
    try {
      return await this.post<ZerodhaEventsRunResponse>(
        URLs.zerodha.eventsRun(),
        data ?? {},
      );
    } catch (error) {
      return reconcileTimedOutAutoRebalanceStart(
        error,
        data,
        () => this.zerodhaEventsHistory({ limit: 50 }),
        async (item) => {
          const analysis = await this.zerodhaEventJob(item.job_id);
          if (!analysis.snapshot_date || !analysis.captured_at) {
            throw new Error(
              "Queued Zerodha events job is missing snapshot metadata.",
            );
          }
          return {
            job_id: analysis.job_id,
            status: analysis.status,
            provider: analysis.provider,
            model: analysis.model,
            snapshot_date: analysis.snapshot_date,
            captured_at: analysis.captured_at,
            created_at: analysis.created_at,
          };
        },
      );
    }
  }

''',
)
replace_api_method(
    "  async zerodhaRunThreats(data?: PortfolioEventRunRequest): Promise<ZerodhaThreatRunResponse> {\n",
    "  indmoneyUsPortfolioOverview(): Promise<IndMoneyUsPortfolioOverviewResponse> {\n",
    '''  async zerodhaRunThreats(
    data?: PortfolioEventRunRequest,
  ): Promise<ZerodhaThreatRunResponse> {
    try {
      return await this.post<ZerodhaThreatRunResponse>(
        URLs.zerodha.threatsRun(),
        data ?? {},
      );
    } catch (error) {
      return reconcileTimedOutAutoRebalanceStart(
        error,
        data,
        () => this.zerodhaThreatsHistory({ limit: 50 }),
        async (item) => {
          const analysis = await this.zerodhaThreatJob(item.job_id);
          if (!analysis.snapshot_date || !analysis.captured_at) {
            throw new Error(
              "Queued Zerodha threats job is missing snapshot metadata.",
            );
          }
          return {
            job_id: analysis.job_id,
            status: analysis.status,
            provider: analysis.provider,
            model: analysis.model,
            snapshot_date: analysis.snapshot_date,
            captured_at: analysis.captured_at,
            created_at: analysis.created_at,
          };
        },
      );
    }
  }

''',
)
replace_api_method(
    "  async indmoneyUsRunEvents(data?: PortfolioEventRunRequest): Promise<IndMoneyUsEventsRunResponse> {\n",
    "  indmoneyUsThreatsLatest(): Promise<IndMoneyUsThreatLatestResponse> {\n",
    '''  async indmoneyUsRunEvents(
    data?: PortfolioEventRunRequest,
  ): Promise<IndMoneyUsEventsRunResponse> {
    try {
      return await this.post<IndMoneyUsEventsRunResponse>(
        URLs.indmoneyUs.eventsRun(),
        data ?? {},
      );
    } catch (error) {
      return reconcileTimedOutAutoRebalanceStart(
        error,
        data,
        () => this.indmoneyUsEventsHistory({ limit: 50 }),
        async (item) => {
          const analysis = await this.indmoneyUsEventJob(item.job_id);
          if (
            analysis.snapshot_id == null ||
            !analysis.snapshot_date ||
            !analysis.captured_at
          ) {
            throw new Error(
              "Queued INDmoney events job is missing snapshot metadata.",
            );
          }
          return {
            job_id: analysis.job_id,
            status: analysis.status,
            provider: analysis.provider,
            model: analysis.model,
            snapshot_id: analysis.snapshot_id,
            snapshot_date: analysis.snapshot_date,
            captured_at: analysis.captured_at,
            created_at: analysis.created_at,
          };
        },
      );
    }
  }

''',
)
replace_api_method(
    "  async indmoneyUsRunThreats(data?: PortfolioEventRunRequest): Promise<IndMoneyUsThreatRunResponse> {\n",
    "  polymarketState(options?: ApiRequestControl): Promise<PolymarketBotState> {\n",
    '''  async indmoneyUsRunThreats(
    data?: PortfolioEventRunRequest,
  ): Promise<IndMoneyUsThreatRunResponse> {
    try {
      return await this.post<IndMoneyUsThreatRunResponse>(
        URLs.indmoneyUs.threatsRun(),
        data ?? {},
      );
    } catch (error) {
      return reconcileTimedOutAutoRebalanceStart(
        error,
        data,
        () => this.indmoneyUsThreatsHistory({ limit: 50 }),
        async (item) => {
          const analysis = await this.indmoneyUsThreatJob(item.job_id);
          if (
            analysis.snapshot_id == null ||
            !analysis.snapshot_date ||
            !analysis.captured_at
          ) {
            throw new Error(
              "Queued INDmoney threats job is missing snapshot metadata.",
            );
          }
          return {
            job_id: analysis.job_id,
            status: analysis.status,
            provider: analysis.provider,
            model: analysis.model,
            snapshot_id: analysis.snapshot_id,
            snapshot_date: analysis.snapshot_date,
            captured_at: analysis.captured_at,
            created_at: analysis.created_at,
          };
        },
      );
    }
  }

''',
)
api_path.write_text(api_text)
