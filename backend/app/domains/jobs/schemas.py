from datetime import datetime
from typing import Optional

from pydantic import BaseModel

from app.shared.types import JobStatus


class JobCreate(BaseModel):
    prompt: str
    provider: str
    model: str
    scheduled_at: Optional[datetime] = None


class JobResponse(BaseModel):
    id: int
    prompt: str
    provider: str
    model: str
    status: JobStatus
    response: Optional[str] = None
    error_message: Optional[str] = None
    tokens_in: Optional[int] = None
    tokens_out: Optional[int] = None
    estimated_cost: Optional[float] = None
    scheduled_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
