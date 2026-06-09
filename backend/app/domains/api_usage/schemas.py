from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class LlmScanPerformanceItem(BaseModel):
    job_id: int
    run_id: int | None = None
    stage: int | None = None
    scan_type: str
    provider: str
    model: str
    status: str
    processing_passed: bool | None = None
    sheet_export_passed: bool | None = None
    export_status: str | None = None
    created_at: datetime
    updated_at: datetime
    exported_at: datetime | None = None
    time_taken_ms: int | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    estimated_cost: float | None = None
    error_message: str | None = None
    export_error: str | None = None


class LlmScanSummary(BaseModel):
    scan_type: str
    total_scans: int
    processing_passed: int
    processing_failed: int
    sheet_export_passed: int
    sheet_export_failed: int
    total_cost: float
    avg_time_taken_ms: int | None = None


class LlmPerformanceGroup(BaseModel):
    provider: str
    model: str
    llm_key: str
    total_scans: int
    processing_passed: int
    processing_failed: int
    sheet_export_passed: int
    sheet_export_failed: int
    total_cost: float
    avg_time_taken_ms: int | None = None
    scan_summaries: list[LlmScanSummary]
    scans: list[LlmScanPerformanceItem]


class LlmPerformanceResponse(BaseModel):
    total_llms: int
    total_scans: int
    generated_at: datetime
    groups: list[LlmPerformanceGroup]


class LlmCostHistoryDay(BaseModel):
    date: str
    estimated_cost: float
    estimated_cost_inr: float
    requests: int
    tokens_in: int
    tokens_out: int


class LlmCostHistoryRun(BaseModel):
    job_id: int
    model: str
    status: str
    timestamp: datetime
    estimated_cost: float
    estimated_cost_inr: float
    tokens_in: int | None = None
    tokens_out: int | None = None


class LlmCostHistoryResponse(BaseModel):
    provider: str
    name: str
    timezone: str
    usd_inr_rate: float
    generated_at: datetime
    day_limit: int
    run_limit: int
    days: list[LlmCostHistoryDay]
    runs: list[LlmCostHistoryRun]
    total_runs: int
    has_more_days: bool
    has_more_runs: bool
