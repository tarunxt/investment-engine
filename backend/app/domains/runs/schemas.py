from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Literal

from app.domains.jobs.schemas import JobResponse
from app.shared.types import JobStatus


class RunModelTarget(BaseModel):
    provider: str
    model: str


class PolymarketEventEvidenceOptions(BaseModel):
    require_fresh_internet_evidence: bool = True
    allow_evidence_grounded_non_web_models: bool = False


class PolymarketEventQuestionPayload(BaseModel):
    question_ref: str
    question_id: str
    question: str
    close_time: str | None = None
    closing_time: str | None = None
    close_time_et: str | None = None
    current_time_utc: str
    current_time_et: str
    deadline_et: str | None = None
    hours_remaining: float | None = None
    deadline_source: str | None = None
    title_date_hint: str | None = None
    title_deadline_et_assumption: str | None = None
    category: str
    outcomes: list[str] = Field(default_factory=list)
    current_yes_odds: float | None = None
    current_no_odds: float | None = None
    market_url: str | None = None
    slug: str | None = None
    polymarket_rules: str | None = None
    polymarket_market_context: str | None = None
    polymarket_resolution_source: str | None = None
    preflight_evidence_block: str | None = None


class PolymarketEventRunContext(BaseModel):
    kind: Literal["polymarket_bullpen_event"] = "polymarket_bullpen_event"
    prompt_template: str
    question_payload: list[PolymarketEventQuestionPayload]
    evidence_options: PolymarketEventEvidenceOptions = Field(
        default_factory=PolymarketEventEvidenceOptions
    )


class AutoRebalanceRunReservationRequest(BaseModel):
    portfolio: str

    @field_validator("portfolio")
    @classmethod
    def normalize_portfolio(cls, value: str) -> str:
        normalized = value.strip()
        if normalized not in {"india", "indmoney_us"}:
            raise ValueError("portfolio must be india or indmoney_us")
        return normalized


class AutoRebalanceRunReservationResponse(BaseModel):
    portfolio: str
    sequence: int
    label: str


class RunCreate(BaseModel):
    prompt: str
    targets: list[RunModelTarget]
    polymarket_event_context: PolymarketEventRunContext | None = None
    prompt_id: Optional[int] = None
    scheduled_at: Optional[datetime] = None
    # Auto-export settings
    auto_export_enabled: bool = False
    export_spreadsheet_url: Optional[str] = None
    export_sheet_name: Optional[str] = None
    export_investment_amount: Optional[str] = None
    export_title: Optional[str] = None
    allow_parallel: bool = False
    auto_rebalance_portfolio: Optional[str] = None
    auto_rebalance_sequence: Optional[int] = None
    auto_rebalance_label: Optional[str] = None

    @field_validator("targets")
    @classmethod
    def targets_not_empty(cls, v: list[RunModelTarget]) -> list[RunModelTarget]:
        if not v:
            raise ValueError("At least one (provider, model) target is required.")

        unique_targets: list[RunModelTarget] = []
        seen: set[tuple[str, str]] = set()
        for target in v:
            key = (target.provider.strip().lower(), target.model.strip().lower())
            if key in seen:
                continue
            seen.add(key)
            unique_targets.append(target)

        return unique_targets

    @field_validator("auto_rebalance_portfolio")
    @classmethod
    def normalize_auto_rebalance_portfolio(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = value.strip()
        if normalized not in {"india", "indmoney_us"}:
            raise ValueError("auto_rebalance_portfolio must be india or indmoney_us")
        return normalized

    @model_validator(mode="after")
    def validate_auto_rebalance_metadata(self) -> "RunCreate":
        metadata_values = [
            self.auto_rebalance_portfolio,
            self.auto_rebalance_sequence,
            self.auto_rebalance_label,
        ]
        if any(value is not None for value in metadata_values) and not all(
            value is not None for value in metadata_values
        ):
            raise ValueError("auto rebalance metadata requires portfolio, sequence, and label")
        return self


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
    export_status: Optional[str] = None
    export_error: Optional[str] = None
    exported_at: Optional[datetime] = None
    exported_sheet_url: Optional[str] = None
    auto_rebalance_portfolio: Optional[str] = None
    auto_rebalance_sequence: Optional[int] = None
    auto_rebalance_label: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class RunListJobResponse(BaseModel):
    id: int
    provider: str
    model: str
    status: JobStatus
    error_message: Optional[str] = None
    tokens_in: Optional[int] = None
    tokens_out: Optional[int] = None
    estimated_cost: Optional[float] = None
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

    model_config = {"from_attributes": True}


class RunListJobLinkResponse(BaseModel):
    id: int
    run_id: int
    job_id: int
    stage: int
    job: RunListJobResponse

    model_config = {"from_attributes": True}


class RunListItem(BaseModel):
    id: int
    prompt_preview: str
    prompt_id: Optional[int] = None
    status: JobStatus
    current_stage: int
    run_jobs: list[RunListJobLinkResponse]
    auto_export_enabled: bool = False
    export_status: Optional[str] = None
    export_error: Optional[str] = None
    exported_at: Optional[datetime] = None
    exported_sheet_url: Optional[str] = None
    auto_rebalance_portfolio: Optional[str] = None
    auto_rebalance_sequence: Optional[int] = None
    auto_rebalance_label: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
