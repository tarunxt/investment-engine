from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domains.auth.dependencies import get_current_user
from app.domains.auth.models import User, UserRole
from app.domains.prompts.models import Prompt
from app.domains.prompts.schemas import PromptCreate, PromptResponse, PromptUpdate
from app.infrastructure.database.session import get_async_db

router = APIRouter(prefix="/prompts", tags=["prompts"])


def _assert_can_write(prompt: Prompt, current_user: User) -> None:
    if prompt.is_system and current_user.role != UserRole.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Only admins can modify system prompts")
    if not prompt.is_system and prompt.user_id != current_user.id and current_user.role != UserRole.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Access denied")


def _apply_prompt_update(prompt: Prompt, update: PromptUpdate, default_name: str | None = None) -> None:
    if update.name is not None:
        prompt.name = update.name
    elif default_name is not None:
        prompt.name = default_name
    if update.description is not None:
        prompt.description = update.description
    if update.is_active is not None:
        prompt.is_active = update.is_active
    if update.body is not None:
        prompt.body = update.body
        prompt.version += 1


async def _get_prompt(db: AsyncSession, prompt_id: int) -> Prompt | None:
    result = await db.execute(select(Prompt).where(Prompt.id == prompt_id))
    return result.scalar_one_or_none()


@router.get("", response_model=list[PromptResponse])
async def get_prompts(
    q: str | None = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    stmt = select(Prompt).where(
        (Prompt.is_system == True) | (Prompt.user_id == current_user.id)  # noqa: E712
    )
    if q:
        stmt = stmt.where(Prompt.name.ilike(f"%{q}%"))
    stmt = stmt.order_by(Prompt.is_system.desc(), Prompt.updated_at.desc())
    result = await db.execute(stmt)
    return result.scalars().all()


@router.post("", response_model=PromptResponse, status_code=201)
async def create_prompt(
    data: PromptCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    if data.is_system and current_user.role != UserRole.ADMIN:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Only admins can create system prompts")

    source_prompt_id = None
    if data.source_prompt_id is not None:
        source_prompt = await _get_prompt(db, data.source_prompt_id)
        if not source_prompt or not source_prompt.is_system:
            raise HTTPException(404, detail="Source system prompt not found")
        source_prompt_id = source_prompt.id

    prompt = Prompt(
        user_id=None if data.is_system else current_user.id,
        source_prompt_id=None if data.is_system else source_prompt_id,
        name=data.name,
        description=data.description,
        body=data.body,
        is_system=data.is_system,
    )
    db.add(prompt)
    await db.commit()
    await db.refresh(prompt)
    return prompt


@router.get("/{prompt_id}", response_model=PromptResponse)
async def get_prompt(
    prompt_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    prompt = await _get_prompt(db, prompt_id)
    if not prompt:
        raise HTTPException(404, detail="Prompt not found")
    if not prompt.is_system and prompt.user_id != current_user.id and current_user.role != UserRole.ADMIN:
        raise HTTPException(403, detail="Access denied")
    return prompt


@router.put("/{prompt_id}", response_model=PromptResponse)
async def update_prompt(
    prompt_id: int,
    update: PromptUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    prompt = await _get_prompt(db, prompt_id)
    if not prompt:
        raise HTTPException(404, detail="Prompt not found")

    if prompt.is_system and current_user.role != UserRole.ADMIN:
        result = await db.execute(
            select(Prompt).where(
                Prompt.source_prompt_id == prompt.id,
                Prompt.user_id == current_user.id,
                Prompt.is_system == False,  # noqa: E712
            )
        )
        personal_prompt = result.scalar_one_or_none()
        if personal_prompt is None:
            personal_prompt = Prompt(
                user_id=current_user.id,
                source_prompt_id=prompt.id,
                name=update.name if update.name is not None else prompt.name,
                description=update.description if update.description is not None else prompt.description,
                body=update.body if update.body is not None else prompt.body,
                is_system=False,
                is_active=update.is_active if update.is_active is not None else prompt.is_active,
            )
            db.add(personal_prompt)
        else:
            _apply_prompt_update(personal_prompt, update, prompt.name)
        await db.commit()
        await db.refresh(personal_prompt)
        return personal_prompt

    _assert_can_write(prompt, current_user)
    _apply_prompt_update(prompt, update)

    await db.commit()
    await db.refresh(prompt)
    return prompt


@router.delete("/{prompt_id}", status_code=204)
async def delete_prompt(
    prompt_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_async_db),
):
    result = await db.execute(select(Prompt).where(Prompt.id == prompt_id))
    prompt = result.scalar_one_or_none()
    if not prompt:
        raise HTTPException(404, detail="Prompt not found")
    _assert_can_write(prompt, current_user)
    await db.delete(prompt)
    await db.commit()
