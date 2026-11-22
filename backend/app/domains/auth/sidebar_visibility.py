"""Global sidebar presentation settings, managed by the existing Cred-X owner."""
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import SidebarVisibility, User
from app.infrastructure.database.session import get_async_db

OWNER_EMAIL = "tarun.singh6893@gmail.com"
router = APIRouter(prefix="/auth/profile/sidebar-visibility", tags=["navigation"])

Destination = Literal[
    "overview", "india-portfolio", "us-portfolio", "bot-overview",
    "bullpen-ai-review", "bullpen-sports", "bullpen008", "bullpen-ai-live",
    "bullpen-copy-trader", "polymarket-direct", "market-scanner", "prompt-library",
    "ai-models", "run-history", "mails", "database", "sports-rankings",
    "api-connections", "profile", "preferences", "usage-costs", "appearance",
]


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    visible_ids: Annotated[list[Destination], Field(max_length=128)]
    revision: Annotated[int, Field(ge=0, strict=True)]

    @field_validator("visible_ids")
    @classmethod
    def canonical_ids(cls, value):
        return sorted(set(value))


class Policy(BaseModel):
    visible_ids: list[Destination] | None
    revision: int
    can_manage: bool


def require_sidebar_owner(user: User = Depends(get_current_user)) -> User:
    # Email uniqueness in this database is case-sensitive. Authorize only the
    # exact existing account, independent of role, username, or login provider.
    if user.email != OWNER_EMAIL:
        raise HTTPException(403, "Only the Cred-X owner can change sidebar visibility")
    return user


@router.get("", response_model=Policy)
async def read_policy(response: Response, user: User = Depends(get_current_user),
                      db: AsyncSession = Depends(get_async_db)):
    row = (await db.execute(select(SidebarVisibility).where(SidebarVisibility.id == 1))).scalar_one()
    response.headers["Cache-Control"] = "private, no-store"
    return Policy(visible_ids=row.visible_ids, revision=row.revision, can_manage=user.email == OWNER_EMAIL)


@router.put("", response_model=Policy)
async def save_policy(selection: Selection, response: Response, user: User = Depends(require_sidebar_owner),
                      db: AsyncSession = Depends(get_async_db)):
    result = await db.execute(
        update(SidebarVisibility)
        .where(SidebarVisibility.id == 1, SidebarVisibility.revision == selection.revision)
        .values(visible_ids=selection.visible_ids, revision=selection.revision + 1)
        .returning(SidebarVisibility.revision)
    )
    revision = result.scalar_one_or_none()
    response.headers["Cache-Control"] = "private, no-store"
    if revision is None:
        current = await read_policy(response, user, db)
        if current.visible_ids == selection.visible_ids:
            return current
        raise HTTPException(409, "Settings changed in another tab. Reload the saved selection and try again.")
    await db.commit()
    return Policy(visible_ids=selection.visible_ids, revision=revision, can_manage=True)
