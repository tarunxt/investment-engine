from pydantic import BaseModel
from datetime import datetime
from typing import Optional


class PromptCreate(BaseModel):
    name: str
    description: Optional[str] = None
    body: str
    is_system: bool = False


class PromptUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    body: Optional[str] = None
    is_active: Optional[bool] = None


class PromptResponse(BaseModel):
    id: int
    user_id: Optional[int]
    name: str
    description: Optional[str]
    body: str
    version: int
    is_system: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
