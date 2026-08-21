from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel

from app.domains.portfolio_events.schemas import PortfolioAnalysisHistoryItemResponse
from app.shared.types import JobStatus


class IndMoneyUsThreatSummaryResponse(BaseModel):
    main_portfolio_risk: str | None = None
    biggest_weakness: str | None = None
    biggest_near_term_threat: str | None = None
    biggest_position_size_risk: str | None = None
    biggest_profit_protection_candidate: str | None = None
    biggest_weak_drag_position: str | None = None


class IndMoneyUsThreatKeyValueItemResponse(BaseModel):
    label: str
    value: str


class IndMoneyUsThreatTableSectionResponse(BaseModel):
    key: str
    title: str
    columns: list[str]
    rows: list[dict[str, str]]


class IndMoneyUsThreatReportResponse(BaseModel):
    summary: IndMoneyUsThreatSummaryResponse
    summary_items: list[IndMoneyUsThreatKeyValueItemResponse]
    tables: list[IndMoneyUsThreatTableSectionResponse]
    bottom_line: list[IndMoneyUsThreatKeyValueItemResponse]
    raw_markdown: str


class IndMoneyUsThreatAnalysisResponse(BaseModel):
    job_id: int
    status: JobStatus
    provider: str
    model: str
    snapshot_id: int | None = None
    snapshot_date: date | None = None
    captured_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    tokens_in: int | None = None
    tokens_out: int | None = None
    estimated_cost: float | None = None
    error_message: str | None = None
    report: IndMoneyUsThreatReportResponse | None = None


class IndMoneyUsThreatLatestResponse(BaseModel):
    analysis: IndMoneyUsThreatAnalysisResponse | None = None


class IndMoneyUsThreatHistoryResponse(BaseModel):
    history: list[PortfolioAnalysisHistoryItemResponse]


class IndMoneyUsThreatRunResponse(BaseModel):
    job_id: int
    status: JobStatus
    provider: str
    model: str
    snapshot_id: int
    snapshot_date: date
    captured_at: datetime
    created_at: datetime
