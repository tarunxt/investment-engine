from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.domains.prompts.models import Prompt

logger = get_logger(__name__)

_PROMPTS_DIR = Path(__file__).parent.parent.parent / "prompts"


@dataclass(frozen=True)
class SystemPromptSeed:
    name: str
    description: str
    file_name: str


_SYSTEM_PROMPTS: tuple[SystemPromptSeed, ...] = (
    SystemPromptSeed(
        name="India Swing-Trade Research",
        description=(
            "Top-tier India aggressive swing-trading strategist prompt. "
            "Identifies 5 high-conviction stock picks for INR 50,000 deployment."
        ),
        file_name="india-swing-trade-research.txt",
    ),
    SystemPromptSeed(
        name="US Swing-Trade Research",
        description=(
            "Top-tier US aggressive swing-trading strategist prompt. "
            "Identifies 5 high-conviction stock picks for USD 100 deployment."
        ),
        file_name="us-swing-trade-research.txt",
    ),
    SystemPromptSeed(
        name="India Portfolio Rebalance Flow",
        description=(
            "Zerodha India portfolio rebalance prompt used by the rebalance flow. "
            "Combines current holdings, completed swing-trade runs, and threat reports."
        ),
        file_name="india-rebalance-flow.txt",
    ),
    SystemPromptSeed(
        name="US Portfolio Rebalance Flow",
        description=(
            "INDmoney US portfolio rebalance prompt used by the rebalance flow. "
            "Combines current holdings, completed swing-trade runs, and threat reports."
        ),
        file_name="us-rebalance-flow.txt",
    ),
    SystemPromptSeed(
        name="Technical Setup Scan Flow",
        description=(
            "Technical setup scan prompt used to tag rebalance candidates with approved "
            "bullish and bearish setup names from the Technical Setups library."
        ),
        file_name="technical-setup-scan-flow.txt",
    ),
    SystemPromptSeed(
        name="Zerodha Threat Scan Flow",
        description=(
            "Zerodha India portfolio threats prompt used to identify short-term portfolio "
            "risks, weak positions, event risks, and urgent risk-control actions."
        ),
        file_name="zerodha-threat-scan-flow.txt",
    ),
    SystemPromptSeed(
        name="INDmoney US Threat Scan Flow",
        description=(
            "INDmoney US portfolio threats prompt used to identify short-term portfolio "
            "risks, weak positions, event risks, and urgent risk-control actions."
        ),
        file_name="indmoney-us-threat-scan-flow.txt",
    ),
    SystemPromptSeed(
        name="Portfolio Event Calendar Scan Flow",
        description=(
            "Portfolio event calendar prompt used by Zerodha and INDmoney US event scans "
            "to find upcoming price-sensitive company events."
        ),
        file_name="portfolio-event-calendar-scan-flow.txt",
    ),
)


async def seed_system_prompts(db: AsyncSession) -> None:
    for seed in _SYSTEM_PROMPTS:
        prompt_file = _PROMPTS_DIR / seed.file_name
        if not prompt_file.exists():
            logger.warning("Seed prompt file not found: %s", prompt_file)
            continue

        body = prompt_file.read_text(encoding="utf-8").strip()
        result = await db.execute(
            select(Prompt)
            .where(Prompt.is_system == True, Prompt.name == seed.name)  # noqa: E712
            .order_by(Prompt.id.asc())
        )
        existing_prompts = result.scalars().all()
        existing = existing_prompts[0] if existing_prompts else None

        if len(existing_prompts) > 1:
            logger.warning(
                "Found %s system prompts named %s; updating the oldest prompt and leaving duplicates untouched",
                len(existing_prompts),
                seed.name,
            )

        if existing:
            existing.description = seed.description
            if (existing.body or "").strip() != body:
                existing.body = body
                existing.version += 1
                logger.info("Updated system prompt body from seed: %s", seed.name)
            else:
                logger.info("System prompt body already current: %s", seed.name)
            existing.is_active = True
        else:
            db.add(
                Prompt(
                    user_id=None,
                    name=seed.name,
                    description=seed.description,
                    body=body,
                    is_system=True,
                    is_active=True,
                )
            )
            logger.info("Seeded system prompt: %s", seed.name)

    await db.commit()
