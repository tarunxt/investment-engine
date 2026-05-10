from pathlib import Path

from sqlalchemy.orm import Session

from app.core.logging import get_logger
from app.models.prompt import Prompt

logger = get_logger(__name__)

_PROMPT_FILE = Path(__file__).parent.parent.parent / "prompts" / "prompt-1.txt"
_SYSTEM_PROMPT_NAME = "India Swing-Trade Research"
_SYSTEM_PROMPT_DESCRIPTION = (
    "Top-tier India aggressive swing-trading strategist prompt. "
    "Identifies 5 high-conviction stock picks for INR 10,000 deployment."
)


def seed_system_prompts(db: Session) -> None:
    """Ensure the default system prompt exists in the database."""
    exists = db.query(Prompt).filter(Prompt.is_system == True).first()  # noqa: E712
    if exists:
        return

    if not _PROMPT_FILE.exists():
        logger.warning("Seed prompt file not found: %s", _PROMPT_FILE)
        return

    body = _PROMPT_FILE.read_text(encoding="utf-8").strip()
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
    db.commit()
    logger.info("Seeded system prompt: %s", _SYSTEM_PROMPT_NAME)
