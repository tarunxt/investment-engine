from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from app.shared.types import JobStatus
from app.shared.exceptions import ValidationException
from .resource_policy import MAX_PROMPT_CHARS, validate_prompt
from .resource_validation import MODEL_IDENTIFIER_MAX_CHARS


class JobCreate(BaseModel):
    prompt: str = Field(max_length=MAX_PROMPT_CHARS)
    provider: str = Field(max_length=MODEL_IDENTIFIER_MAX_CHARS)
    model: str = Field(max_length=MODEL_IDENTIFIER_MAX_CHARS)
    scheduled_at: Optional[datetime] = None

    @field_validator("prompt")
    @classmethod
    def bounded_prompt(cls, value):
        try:
            return validate_prompt(value)
        except ValidationException as exc:
            raise ValueError(exc.message) from None


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
    web_search_used: Optional[bool] = None
    web_search_queries: Optional[list[str]] = None
    web_sources: Optional[list[str]] = None
    request_context_json: Optional[dict] = None
    runtime_metadata_json: Optional[dict] = None
    export_status: Optional[str] = None
    export_error: Optional[str] = None
    exported_at: Optional[datetime] = None
    exported_sheet_url: Optional[str] = None
    auto_rebalance_portfolio: Optional[str] = None
    auto_rebalance_sequence: Optional[int] = None
    auto_rebalance_label: Optional[str] = None
    scheduled_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def partial_usage_projection(self):
        from .partial_output import project_partial_output
        return project_partial_output(self)

    model_config = {"from_attributes": True}
