"""Owner-managed global and per-account sidebar presentation settings."""
import json
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import ActivityLog, User
from app.infrastructure.database.session import get_async_db

OWNER_EMAIL = "tarun.singh6893@gmail.com"
ACTION = "navigation.sidebar_visibility"
router = APIRouter(prefix="/auth/profile/sidebar-visibility", tags=["navigation"])

Destination = Literal[
    "overview", "india-portfolio", "us-portfolio", "bot-overview",
    "bullpen-ai-review", "bullpen-sports", "bullpen008", "bullpen-ai-live",
    "bullpen-copy-trader", "polymarket-direct", "market-scanner", "prompt-library",
    "ai-models", "run-history", "mails", "database", "sports-rankings",
    "api-connections", "profile", "preferences", "usage-costs", "appearance",
]


Mode = Literal["inherit", "extra", "custom"]
Target = Annotated[int | None, Query(ge=1, le=2147483647)]


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Mode
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


class EditorSettings(BaseModel):
    mode: Mode
    visible_ids: list[Destination] | None
    revision: int
    global_ids: list[Destination] | None


class AccountOption(BaseModel):
    id: int
    email: str
    username: str


def require_sidebar_owner(user: User = Depends(get_current_user)) -> User:
    # Email uniqueness in this database is case-sensitive. Authorize only the
    # exact existing account, independent of role, username, or login provider.
    if user.email != OWNER_EMAIL:
        raise HTTPException(403, "Only the Cred-X owner can change sidebar visibility")
    return user


def scope_for(user_id: int | None) -> str:
    return "global" if user_id is None else f"user:{user_id}"


async def editor_settings(db: AsyncSession, user_id: int | None) -> EditorSettings:
    scope = scope_for(user_id)
    latest = (
        select(func.max(ActivityLog.id)).join(User, User.id == ActivityLog.user_id)
        .where(User.email == OWNER_EMAIL, ActivityLog.action == ACTION,
               ActivityLog.resource_type.in_({"global", scope}))
        .group_by(ActivityLog.resource_type)
    )
    rows = (await db.execute(select(ActivityLog.resource_type, ActivityLog.details, ActivityLog.resource_id)
                             .where(ActivityLog.id.in_(latest)))).all()
    saved = {key: Selection(**json.loads(details), revision=revision) for key, details, revision in rows}
    defaults = saved.get("global")
    selection = saved.get(scope)
    return EditorSettings(
        mode=selection.mode if selection else ("custom" if user_id is None else "inherit"),
        visible_ids=selection.visible_ids if selection else (None if user_id is None else []),
        revision=selection.revision if selection else 0,
        global_ids=defaults.visible_ids if defaults else None,
    )


def effective_ids(settings: EditorSettings) -> list[Destination] | None:
    if settings.mode == "custom":
        return settings.visible_ids
    if settings.mode == "inherit" or settings.global_ids is None:
        return settings.global_ids
    return sorted(set(settings.global_ids).union(settings.visible_ids or []))


@router.get("", response_model=Policy)
async def read_policy(response: Response, user: User = Depends(get_current_user),
                      db: AsyncSession = Depends(get_async_db)):
    response.headers["Cache-Control"] = "private, no-store"
    settings = await editor_settings(db, user.id)
    return Policy(visible_ids=effective_ids(settings), revision=settings.revision,
                  can_manage=user.email == OWNER_EMAIL)


@router.get("/users", response_model=list[AccountOption])
async def search_users(response: Response, q: Annotated[str, Query(max_length=255)] = "",
                       owner: User = Depends(require_sidebar_owner), db: AsyncSession = Depends(get_async_db)):
    query = select(User.id, User.email, User.username)
    term = q.strip().lower()
    if term:
        query = query.where(or_(func.lower(User.email).contains(term, autoescape=True),
                                func.lower(User.username).contains(term, autoescape=True)))
    response.headers["Cache-Control"] = "private, no-store"
    return (await db.execute(query.order_by(User.email, User.id).limit(30))).mappings().all()


async def require_target(db: AsyncSession, user_id: int | None):
    if user_id is not None and await db.scalar(select(User.id).where(User.id == user_id)) is None:
        raise HTTPException(404, "Account no longer exists")


@router.get("/settings", response_model=EditorSettings)
async def read_settings(response: Response, user_id: Target = None, owner: User = Depends(require_sidebar_owner),
                        db: AsyncSession = Depends(get_async_db)):
    await require_target(db, user_id)
    response.headers["Cache-Control"] = "private, no-store"
    return await editor_settings(db, user_id)


@router.put("/settings", response_model=EditorSettings)
async def save_settings(selection: Selection, response: Response, user_id: Target = None,
                        owner: User = Depends(require_sidebar_owner), db: AsyncSession = Depends(get_async_db)):
    if user_id is None and selection.mode != "custom":
        raise HTTPException(422, "Choose a list for the global defaults")
    if selection.mode == "inherit" and selection.visible_ids:
        raise HTTPException(422, "An inherited selection must have no overrides")
    response.headers["Cache-Control"] = "private, no-store"
    await require_target(db, user_id)
    # Serialize compare-and-append, including the first save for each scope.
    await db.execute(select(User.id).where(User.id == owner.id).with_for_update())
    current = await editor_settings(db, user_id)
    if current.mode == selection.mode and current.visible_ids == selection.visible_ids:
        return current
    if current.revision != selection.revision:
        raise HTTPException(409, "Settings changed in another tab. Reload the saved selection and try again.")
    db.add(ActivityLog(user_id=owner.id, action=ACTION, resource_type=scope_for(user_id),
                       resource_id=current.revision + 1, details=selection.model_dump_json(exclude={"revision"})))
    await db.flush()
    saved = await editor_settings(db, user_id)
    await db.commit()
    return saved
