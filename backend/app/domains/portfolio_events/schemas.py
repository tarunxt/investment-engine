from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, field_validator, model_validator

from app.shared.types import JobStatus


class PortfolioEventCalendarTableResponse(BaseModel):
    columns: list[str]
    rows: list[dict[str, str]]
    raw_markdown: str


class PortfolioAnalysisHistoryItemResponse(BaseModel):
    job_id: int
    status: JobStatus
    provider: str
    model: str
    snapshot_date: date | None = None
    captured_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    estimated_cost: float | None = None
    error_message: str | None = None


class PortfolioEventRunRequest(BaseModel):
    provider: str | None = None
    model: str | None = None

    @field_validator("provider", "model", mode="before")
    @classmethod
    def _normalize_optional_text(cls, value: object) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @model_validator(mode="after")
    def _validate_target_pair(self) -> "PortfolioEventRunRequest":
        if bool(self.provider) != bool(self.model):
            raise ValueError("Provide both provider and model together.")
        return self
