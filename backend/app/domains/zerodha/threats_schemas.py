from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel

from app.domains.portfolio_events.schemas import PortfolioAnalysisHistoryItemResponse
from app.shared.types import JobStatus


class ZerodhaThreatSummaryResponse(BaseModel):
    main_portfolio_risk: str | None = None
    biggest_weakness: str | None = None
    biggest_near_term_threat: str | None = None
    biggest_position_size_risk: str | None = None
    biggest_profit_protection_candidate: str | None = None
    biggest_weak_drag_position: str | None = None


class ZerodhaThreatKeyValueItemResponse(BaseModel):
    label: str
    value: str


class ZerodhaThreatTableSectionResponse(BaseModel):
    key: str
    title: str
    columns: list[str]
    rows: list[dict[str, str]]


class ZerodhaThreatReportResponse(BaseModel):
    summary: ZerodhaThreatSummaryResponse
    summary_items: list[ZerodhaThreatKeyValueItemResponse]
    tables: list[ZerodhaThreatTableSectionResponse]
    bottom_line: list[ZerodhaThreatKeyValueItemResponse]
    raw_markdown: str


class ZerodhaThreatAnalysisResponse(BaseModel):
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
    report: ZerodhaThreatReportResponse | None = None


class ZerodhaThreatLatestResponse(BaseModel):
    analysis: ZerodhaThreatAnalysisResponse | None = None


class ZerodhaThreatHistoryResponse(BaseModel):
    history: list[PortfolioAnalysisHistoryItemResponse]


class ZerodhaThreatRunResponse(BaseModel):
    job_id: int
    status: JobStatus
    provider: str
    model: str
    snapshot_date: date
    captured_at: datetime
    created_at: datetime
