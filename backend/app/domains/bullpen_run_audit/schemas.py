from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.domains.bullpen_run_audit.constants import AUDIT_SECTION_KEYS

AuditFindingSeverity = Literal["critical", "high", "medium", "low", "info"]
AuditSnapshotSource = Literal["native", "reconstructed"]
AuditSnapshotLifecycleStatus = Literal["working", "frozen", "incomplete"]
AuditManualCheckStatus = Literal["unchecked", "pass", "fail", "not_applicable"]
AuditFeedbackStatus = Literal["queued", "processing", "completed", "failed"]


class BullpenRunAuditSummaryItem(BaseModel):
    run_id: str
    snapshot_id: int
    snapshot_version: int
    run_status: str
    triggered_by: str
    dry_run: bool
    live_execution_requested: bool
    live_execution_attempted: bool
    started_at: str
    completed_at: str | None = None
    duration_seconds: float | None = None
    execution_version: str | None = None
    strategy_version: str | None = None
    backend_commit_sha: str | None = None
    frontend_build_sha: str | None = None
    deployment_id: str | None = None
    stage1_status: str | None = None
    stage2_status: str | None = None
    stage3_status: str | None = None
    scanned_candidate_count: int = 0
    candidate_rows_before_llm: int = 0
    llm_candidate_count: int = 0
    llm_configured_call_count: int = 0
    llm_attempted_call_count: int = 0
    llm_succeeded_call_count: int = 0
    llm_failed_call_count: int = 0
    qualified_candidate_count: int = 0
    ranked_count: int = 0
    final_selection_count: int = 0
    decisions_count: int = 0
    orders_planned: int = 0
    orders_submitted: int = 0
    orders_confirmed: int = 0
    orders_filled: int = 0
    orders_permanently_failed: int = 0
    findings_critical: int = 0
    findings_high: int = 0
    findings_medium: int = 0
    findings_low: int = 0
    findings_info: int = 0
    validation_failure_count: int = 0
    provider_failure_count: int = 0
    incomplete_data_count: int = 0
    manual_deficiency_count: int = 0
    source_kind: AuditSnapshotSource
    lifecycle_status: AuditSnapshotLifecycleStatus
    audit_status: str
    completeness_pct: float = 0
    feedback_status: AuditFeedbackStatus | None = None
    feedback_provider: str | None = None
    feedback_model: str | None = None


class BullpenRunAuditListResponse(BaseModel):
    items: list[BullpenRunAuditSummaryItem] = Field(default_factory=list)
    page: int = 1
    limit: int = 20
    total: int = 0
    total_pages: int = 0


class BullpenRunAuditMetadata(BaseModel):
    snapshot_id: int
    snapshot_version: int
    snapshot_schema_version: int
    run_id: str
    run_status: str
    triggered_by: str
    started_at: str
    completed_at: str | None = None
    duration_seconds: float | None = None
    dry_run: bool
    live_execution_requested: bool
    live_execution_attempted: bool
    execution_version: str | None = None
    strategy_version: str | None = None
    source_kind: AuditSnapshotSource
    lifecycle_status: AuditSnapshotLifecycleStatus
    audit_status: str
    completeness_pct: float = 0
    canonical_bundle_hash: str | None = None
    backend_commit_sha: str | None = None
    frontend_build_sha: str | None = None
    deployment_id: str | None = None
    build_time: str | None = None
    alembic_revision: str | None = None
    settings_hash: str | None = None
    section_index: dict[str, Any] = Field(default_factory=dict)
    provenance: dict[str, Any] = Field(default_factory=dict)
    missing_fields: list[Any] = Field(default_factory=list)


class BullpenRunAuditFinding(BaseModel):
    id: int
    code: str
    rule_version: str
    severity: AuditFindingSeverity
    stage: str
    category: str
    title: str
    explanation: str
    observed_value: str | None = None
    expected_value: str | None = None
    blocking: bool = False
    classification: str
    suggested_remediation: str | None = None
    evidence_pointers: list[Any] = Field(default_factory=list)
    detection_metadata: dict[str, Any] = Field(default_factory=dict)
    resolution_status: str
    resolution_remark: str | None = None
    created_at: str
    updated_at: str


class BullpenRunAuditRemark(BaseModel):
    id: int
    scope_type: str
    scope_id: str | None = None
    remark_type: str
    body: str
    author_label: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    supersedes_remark_id: int | None = None
    created_at: str
    updated_at: str


class BullpenRunAuditManualCheck(BaseModel):
    id: int
    check_key: str
    check_label: str
    status: AuditManualCheckStatus
    scope_type: str
    scope_id: str | None = None
    description: str | None = None
    remark: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    supersedes_check_id: int | None = None
    created_at: str
    updated_at: str


class BullpenRunAuditFeedbackSummary(BaseModel):
    id: int
    status: AuditFeedbackStatus
    provider: str
    model: str
    prompt_version: str
    prompt_hash: str
    report_version: str
    chunk_count: int = 0
    chunk_coverage_pct: float = 0
    snapshot_hash: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    estimated_cost: float = 0
    latency_seconds: float = 0
    error_message: str | None = None
    codex_prompt: str | None = None
    created_at: str
    updated_at: str
    completed_at: str | None = None


class BullpenRunAuditFeedbackSubcall(BaseModel):
    id: int
    chunk_index: int
    section_keys: list[Any] = Field(default_factory=list)
    status: str
    provider: str
    model: str
    prompt_hash: str
    parsed_output: dict[str, Any] | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    estimated_cost: float = 0
    latency_seconds: float = 0
    coverage_pct: float = 0
    error_message: str | None = None
    created_at: str
    updated_at: str


class BullpenRunAuditFeedbackDetail(BullpenRunAuditFeedbackSummary):
    report_json: dict[str, Any] = Field(default_factory=dict)
    subcalls: list[BullpenRunAuditFeedbackSubcall] = Field(default_factory=list)


class BullpenRunAuditDetailResponse(BaseModel):
    snapshot: BullpenRunAuditMetadata
    findings_summary: dict[str, int] = Field(default_factory=dict)
    findings: list[BullpenRunAuditFinding] = Field(default_factory=list)
    latest_manual_checks: list[BullpenRunAuditManualCheck] = Field(default_factory=list)
    manual_check_history: list[BullpenRunAuditManualCheck] = Field(default_factory=list)
    remarks: list[BullpenRunAuditRemark] = Field(default_factory=list)
    feedback_history: list[BullpenRunAuditFeedbackSummary] = Field(default_factory=list)
    available_sections: list[str] = Field(default_factory=lambda: list(AUDIT_SECTION_KEYS))


class BullpenRunAuditSectionResponse(BaseModel):
    run_id: str
    snapshot_id: int
    canonical_bundle_hash: str | None = None
    section: str
    data: Any


class BullpenRunAuditMaterializeResponse(BaseModel):
    status: str
    snapshot: BullpenRunAuditMetadata


class BullpenRunAuditRemarkCreateRequest(BaseModel):
    scope_type: str = Field(min_length=1, max_length=64)
    scope_id: str | None = Field(default=None, max_length=128)
    remark_type: str = Field(default="note", min_length=1, max_length=64)
    body: str = Field(min_length=1, max_length=10_000)
    metadata: dict[str, Any] = Field(default_factory=dict)
    supersedes_remark_id: int | None = None


class BullpenRunAuditManualCheckUpdateRequest(BaseModel):
    check_key: str = Field(min_length=1, max_length=128)
    status: AuditManualCheckStatus
    scope_type: str = Field(default="run", min_length=1, max_length=64)
    scope_id: str | None = Field(default=None, max_length=128)
    remark: str | None = Field(default=None, max_length=10_000)
    metadata: dict[str, Any] = Field(default_factory=dict)


class BullpenRunAuditFeedbackCreateRequest(BaseModel):
    provider: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=255)
    force_rerun: bool = False

