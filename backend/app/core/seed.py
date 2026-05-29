from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.domains.prompts.models import Prompt

logger = get_logger(__name__)

_PROMPT_FILE = Path(__file__).parent.parent.parent / "prompts" / "prompt-1.txt"
_SYSTEM_PROMPT_NAME = "India Swing-Trade Research"
_SYSTEM_PROMPT_DESCRIPTION = (
    "Top-tier India aggressive swing-trading strategist prompt. "
    "Identifies 5 high-conviction stock picks for INR 50,000 deployment."
)


async def seed_system_prompts(db: AsyncSession) -> None:
    if not _PROMPT_FILE.exists():
        logger.warning("Seed prompt file not found: %s", _PROMPT_FILE)
        return

    body = _PROMPT_FILE.read_text(encoding="utf-8").strip()
    result = await db.execute(
        select(Prompt).where(Prompt.is_system == True, Prompt.name == _SYSTEM_PROMPT_NAME)  # noqa: E712
    )
    existing = result.scalar_one_or_none()

    if existing:
        existing.description = _SYSTEM_PROMPT_DESCRIPTION
        existing.body = body
        existing.is_active = True
        existing.version += 1
        logger.info("Updated system prompt: %s", _SYSTEM_PROMPT_NAME)
    else:
        db.add(
            Prompt(
                user_id=None,
                name=_SYSTEM_PROMPT_NAME,
                description=_SYSTEM_PROMPT_DESCRIPTION,
                body=body,
                is_system=True,
                is_active=True,
            )
        )
        logger.info("Seeded system prompt: %s", _SYSTEM_PROMPT_NAME)

    await db.commit()
