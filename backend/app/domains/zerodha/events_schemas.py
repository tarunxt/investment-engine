from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel

from app.domains.portfolio_events.schemas import (
    PortfolioAnalysisHistoryItemResponse,
    PortfolioEventCalendarTableResponse,
)
from app.shared.types import JobStatus


class ZerodhaEventsAnalysisResponse(BaseModel):
    job_id: int
    status: JobStatus
    provider: str
    model: str
    snapshot_date: date | None = None
    captured_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    tokens_in: int | None = None
    tokens_out: int | None = None
    estimated_cost: float | None = None
    error_message: str | None = None
    table: PortfolioEventCalendarTableResponse | None = None


class ZerodhaEventsLatestResponse(BaseModel):
    analysis: ZerodhaEventsAnalysisResponse | None = None


class ZerodhaEventsHistoryResponse(BaseModel):
    history: list[PortfolioAnalysisHistoryItemResponse]


class ZerodhaEventsRunResponse(BaseModel):
    job_id: int
    status: JobStatus
    provider: str
    model: str
    snapshot_date: date
    captured_at: datetime
    created_at: datetime
