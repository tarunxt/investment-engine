from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.db.auth_dependencies import get_current_user
from app.db.dependencies import get_db
from app.models.prompt import Prompt
from app.models.user import User, UserRole
from app.schemas.prompt import PromptCreate, PromptUpdate, PromptResponse

router = APIRouter(prefix="/prompts", tags=["prompts"])


def _assert_can_write(prompt: Prompt, current_user: User) -> None:
    """Raise 403 if the current user cannot modify this prompt."""
    if prompt.is_system and current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins can modify system prompts")
    if not prompt.is_system and prompt.user_id != current_user.id and current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


@router.get("", response_model=List[PromptResponse])
def get_prompts(
    q: str | None = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return all system prompts plus the current user's own prompts, optionally filtered by name."""
    query = (
        db.query(Prompt)
        .filter(
            (Prompt.is_system == True) | (Prompt.user_id == current_user.id)  # noqa: E712
        )
    )
    if q:
        query = query.filter(Prompt.name.ilike(f"%{q}%"))
    return (
        query
        .order_by(Prompt.is_system.desc(), Prompt.updated_at.desc())
        .all()
    )


@router.post("", response_model=PromptResponse, status_code=201)
def create_prompt(
    data: PromptCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if data.is_system and current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only admins can create system prompts")

    db_prompt = Prompt(
        user_id=None if data.is_system else current_user.id,
        name=data.name,
        description=data.description,
        body=data.body,
        is_system=data.is_system,
    )
    db.add(db_prompt)
    db.commit()
    db.refresh(db_prompt)
    return db_prompt


@router.get("/{prompt_id}", response_model=PromptResponse)
def get_prompt(
    prompt_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    prompt = db.query(Prompt).filter(Prompt.id == prompt_id).first()
    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt not found")
    if not prompt.is_system and prompt.user_id != current_user.id and current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Access denied")
    return prompt


@router.put("/{prompt_id}", response_model=PromptResponse)
def update_prompt(
    prompt_id: int,
    update: PromptUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    prompt = db.query(Prompt).filter(Prompt.id == prompt_id).first()
    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt not found")
    _assert_can_write(prompt, current_user)

    if update.name is not None:
        prompt.name = update.name
    if update.description is not None:
        prompt.description = update.description
    if update.is_active is not None:
        prompt.is_active = update.is_active
    if update.body is not None:
        prompt.body = update.body
        prompt.version += 1

    db.commit()
    db.refresh(prompt)
    return prompt


@router.delete("/{prompt_id}", status_code=204)
def delete_prompt(
    prompt_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    prompt = db.query(Prompt).filter(Prompt.id == prompt_id).first()
    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt not found")
    _assert_can_write(prompt, current_user)
    db.delete(prompt)
    db.commit()
