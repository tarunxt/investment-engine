from pydantic import BaseModel
from typing import Optional


class JobCreate(BaseModel):
    prompt: str
    provider: str
    model: str


class JobResponse(BaseModel):
    id: int
    prompt: str
    response: Optional[str]
    error_message: Optional[str]

    provider: str
    model: str
    status: str
    tokens_in: Optional[int] = None
    tokens_out: Optional[int] = None
    estimated_cost: Optional[float] = None

    class Config:
        from_attributes = True
