from datetime import datetime
from typing import Optional

from pydantic import BaseModel, field_validator

from app.domains.jobs.schemas import JobResponse
from app.shared.types import JobStatus


class RunModelTarget(BaseModel):
    provider: str
    model: str


class RunCreate(BaseModel):
    prompt: str
    targets: list[RunModelTarget]
    prompt_id: Optional[int] = None
    scheduled_at: Optional[datetime] = None
    # Auto-export settings
    auto_export_enabled: bool = False
    export_spreadsheet_url: Optional[str] = None
    export_sheet_name: Optional[str] = None
    export_investment_amount: Optional[str] = None
    export_title: Optional[str] = None

    @field_validator("targets")
    @classmethod
    def targets_not_empty(cls, v: list[RunModelTarget]) -> list[RunModelTarget]:
        if not v:
            raise ValueError("At least one (provider, model) target is required.")
        return v


class RunJobResponse(BaseModel):
    id: int
    run_id: int
    job_id: int
    stage: int
    job: JobResponse

    model_config = {"from_attributes": True}


class RunResponse(BaseModel):
    id: int
    prompt: str
    prompt_id: Optional[int] = None
    status: JobStatus
    current_stage: int
    run_jobs: list[RunJobResponse]
    synthesis_response: Optional[str] = None
    decision_response: Optional[str] = None
    auto_export_enabled: bool = False
    export_spreadsheet_url: Optional[str] = None
    export_sheet_name: Optional[str] = None
    export_investment_amount: Optional[str] = None
    export_title: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class RunListItem(BaseModel):
    id: int
    prompt: str
    status: JobStatus
    current_stage: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
