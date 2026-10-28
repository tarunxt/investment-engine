"""Separate governed evidence DTO; never a legacy formula/order payload."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class EvidenceRow(Strict):
    id: str
    instrument: str
    action: Literal['hold', 'buy', 'trim', 'sell']
    current_units: str
    final_units: str
    allocation: str
    units_change: str
    units_change_kind: Literal['arithmetic_from_recorded_units']


class EvidenceStage(Strict):
    stage: Literal['sync', 'threats', 'swing', 'rebalance', 'technical', 'actionables']
    status: str
    job_id: int | None
    state: Literal['available', 'not_completed', 'not_applicable']
    result_hash: str | None
    response_hash: str | None
    provider: str | None
    model: str | None
    prompt_version: str | None
    rows: list[EvidenceRow] = Field(max_length=200)


class GovernedEvidence(Strict):
    schema_version: Literal[1]
    source_kind: Literal['governed_stage_jobs']
    owner_id: int
    workflow_id: int
    workflow_version: int
    portfolio: Literal['india', 'indmoney_us']
    workflow_status: str
    module_version: int
    source_hash: str
    plan_hash: str
    captured_at: str
    currency: Literal['INR', 'USD']
    simulation: Literal[True]
    historical: Literal[True]
    orders_authorized: Literal[False]
    current_readiness: Literal['not_established']
    budget_verification: Literal['not_assessed']
    integrity: Literal['frozen_job_checkpoint_verified']
    missing_fields: list[str]
    stages: list[EvidenceStage] = Field(min_length=6, max_length=6)
    evidence_hash: str


class CatalogueItem(Strict):
    id: int
    workflow_version: int
    status: str
    module_version: int | None
    recorded_at: str


class GovernedCatalogue(Strict):
    schema_version: Literal[1]
    source_kind: Literal['governed_stage_jobs']
    owner_id: int
    portfolio: Literal['india', 'indmoney_us']
    limit: Literal[30]
    items: list[CatalogueItem]
