from datetime import datetime
from typing import Optional

from pydantic import BaseModel, model_validator

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
    dispatch_status: Optional[str] = None
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
